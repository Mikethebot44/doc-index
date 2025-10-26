import FirecrawlApp from '@mendable/firecrawl-js';
import { chunkMarkdown, chunkText } from './chunking';
import { generateEmbeddings } from './openai';
import { upsertVectors, getOrCreateIndex } from './pinecone';
import { retry } from './utils/retry';
import { addResource, updateResource } from './resource-manager';
import { VectorRecord, Resource, IndexDocumentationOptions } from './types';
import { getEmbeddingDimensions } from './openai';

export async function indexDocumentation(
  openaiKey: string,
  pineconeKey: string,
  firecrawlKey: string,
  indexName: string,
  url: string,
  options: IndexDocumentationOptions = {},
  progressCallback?: (progress: { current: number; total: number }) => void
): Promise<string> {
  const app = new FirecrawlApp({ apiKey: firecrawlKey });
  
  const resourceId = `doc:${url}`;
  const resourceName = new URL(url).hostname;
  
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  
  const resource: Resource = {
    id: resourceId,
    name: resourceName,
    type: 'doc',
    status: 'indexing',
    chunksProcessed: 0,
    totalChunks: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  await addResource(index, resource);
  
  try {
    const crawlResponse = await retry(
      async () => {
        return await app.scrapeUrl(url, {
          onlyMainContent: true,
        });
      }
    );
    
    if (!crawlResponse.data || !crawlResponse.data.content) {
      throw new Error('No content returned from Firecrawl');
    }
    
    const content = crawlResponse.data.content;
    const markdownChunks = chunkMarkdown(content);
    
    resource.totalChunks = markdownChunks.length;
    await updateResource(index, resourceId, { totalChunks: markdownChunks.length });
    
    const embeddings = await generateEmbeddings(
      openaiKey,
      markdownChunks.map(chunk => chunk.text)
    );
    
    const vectors: VectorRecord[] = markdownChunks.map((chunk, i) => ({
      id: `${resourceId}:chunk:${i}`,
      values: embeddings[i],
      metadata: {
        type: 'doc',
        resourceId,
        resourceName,
        url,
        content: chunk.text,
        header: chunk.metadata?.header,
        indexed: Date.now(),
      },
    }));
    
    await upsertVectors(index, vectors);
    
    await updateResource(index, resourceId, {
      status: 'ready',
      chunksProcessed: markdownChunks.length,
      updatedAt: Date.now(),
    });
    
    if (progressCallback) {
      progressCallback({ current: markdownChunks.length, total: markdownChunks.length });
    }
    
    return resourceId;
  } catch (error) {
    await updateResource(index, resourceId, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
    throw error;
  }
}

