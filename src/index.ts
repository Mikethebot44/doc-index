import {
  DocIndexConfig,
  IndexDocumentationOptions,
  SearchOptions,
  SearchResult,
  Resource,
  FindDocsOptions,
  FindDocsResult,
  AskAgentOptions,
} from './types';
import { indexDocumentation, searchFirecrawlUrls } from './firecrawl';
import { searchDocumentation, searchDocumentationGrouped } from './search';
import { getOrCreateIndex } from './pinecone';
import { getEmbeddingDimensions, splitTextToTokenLimit } from './openai';

export class DocIndexSDK {
  private openaiKey: string;
  private pineconeKey: string;
  private indexName: string;
  private firecrawlKey: string | undefined;

  constructor(config: DocIndexConfig) {
    this.openaiKey = config.openaiKey;
    this.pineconeKey = config.pineconeKey;
    this.indexName = config.pineconeIndexName || 'doc-index';
    this.firecrawlKey = config.firecrawlKey;
  }

  async summarizeDocumentation(
    query: string,
    options: { topPages?: number; model?: string } = {}
  ): Promise<string> {
    const topPages = options.topPages ?? 3;
    const modelName = options.model ?? 'gpt-5-mini';

    const pages = await this.searchDocumentationGrouped(query, { returnPage: true });
    const top = (pages as any[]).slice(0, topPages);
    if (!top || top.length === 0) {
      throw new Error('No matching documents found to summarize');
    }

    const perPageMaxTokens = 2000;
    const parts: string[] = [];
    for (const p of top) {
      const slices = await splitTextToTokenLimit(this.openaiKey, String(p.page || ''), perPageMaxTokens);
      if (slices.length > 0) parts.push(`URL: ${p.url}\n\n${slices[0]}`);
    }
    if (parts.length === 0) {
      throw new Error('Unable to prepare content for summarization');
    }
    const corpus = parts.join('\n\n---\n\n');

    // Dynamic any-typed imports to avoid DTS coupling
    const aiMod: any = await import('ai');
    const openaiMod: any = await import('@ai-sdk/openai');
    const openaiProvider = openaiMod.createOpenAI({ apiKey: this.openaiKey });

    const result: any = await aiMod.generateText({
      model: openaiProvider(modelName),
      temperature: 0.3,
      maxOutputTokens: 400,
      prompt: `Summarize the key steps and important details succinctly.\n\nQuery: ${query}\n\nDocuments:\n${corpus}`,
    });
    const text = result?.text ?? '';
    if (!text || !String(text).trim()) {
      throw new Error('No summary returned by the model');
    }
    return String(text);
  }

  async askAgent(
    question: string,
    options: AskAgentOptions = {}
  ): Promise<string> {
    const { runDocIndexAgent } = await import('./agent');
    return await runDocIndexAgent({
      sdk: this,
      question,
      openaiKey: this.openaiKey,
      options,
    });
  }

  async indexDocumentation(
    url: string,
    options: IndexDocumentationOptions = {},
    onProgress?: (current: number, total: number) => void
  ): Promise<string> {
    if (!this.firecrawlKey) {
      throw new Error('Firecrawl API key is required for indexing documentation');
    }
    
    const wrappedProgress = onProgress ? (progress: { current: number; total: number }) => {
      onProgress(progress.current, progress.total);
    } : undefined;
    
    return await indexDocumentation(
      this.openaiKey,
      this.pineconeKey,
      this.firecrawlKey,
      this.indexName,
      url,
      options,
      wrappedProgress
    );
  }

  async searchDocumentation(
    query: string,
    sources?: string[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    return await searchDocumentation(
      this.openaiKey,
      this.pineconeKey,
      this.indexName,
      query,
      sources,
      options
    );
  }

  async searchDocumentationGrouped(
    query: string,
    options: SearchOptions & { returnPage?: boolean; perPageLimit?: number } = {}
  ) {
    return await searchDocumentationGrouped(
      this.openaiKey,
      this.pineconeKey,
      this.indexName,
      query,
      options
    );
  }

  async findDocs(
    query: string,
    options: FindDocsOptions = {}
  ): Promise<FindDocsResult[]> {
    if (!this.firecrawlKey) {
      throw new Error('Firecrawl API key is required for finding documents');
    }
    return await searchFirecrawlUrls(this.firecrawlKey, query, options);
  }

  async listResources(): Promise<Resource[]> {
    const index = await getOrCreateIndex(
      this.pineconeKey,
      this.indexName,
      getEmbeddingDimensions()
    );
    const { getResources: getResourcesFromIndex } = await import('./resource-manager');
    return await getResourcesFromIndex(index);
  }

  async getResource(resourceId: string): Promise<Resource | undefined> {
    const index = await getOrCreateIndex(
      this.pineconeKey,
      this.indexName,
      getEmbeddingDimensions()
    );
    const { getResource: getResourceFromIndex } = await import('./resource-manager');
    return await getResourceFromIndex(index, resourceId);
  }

  async checkResourceStatus(resourceId: string): Promise<Resource | undefined> {
    return await this.getResource(resourceId);
  }

  async renameResource(resourceId: string, newName: string): Promise<void> {
    const index = await getOrCreateIndex(
      this.pineconeKey,
      this.indexName,
      getEmbeddingDimensions()
    );
    const { updateResource: updateResourceMetadata } = await import('./resource-manager');
    await updateResourceMetadata(index, resourceId, { name: newName });
    
    const { queryVectors, upsertVectors } = await import('./pinecone');
    const matches = await queryVectors(
      index,
      Array(3072).fill(0),
      10000,
      { resourceId: { $eq: resourceId } }
    );
    
    const updates = matches.map(match => ({
      id: match.id as string,
      values: match.values as number[],
      metadata: {
        ...match.metadata,
        resourceName: newName,
      } as any,
    }));
    
    await upsertVectors(index, updates);
  }

  async deleteResource(resourceId: string): Promise<void> {
    const index = await getOrCreateIndex(
      this.pineconeKey,
      this.indexName,
      getEmbeddingDimensions()
    );
    const { deleteResource: deleteResourceMetadata, deleteResourceFromPinecone: deleteVectorsFromPinecone } = await import('./resource-manager');
    await deleteResourceMetadata(index, resourceId);
    await deleteVectorsFromPinecone(index, resourceId);
  }
}

export * from './types';

