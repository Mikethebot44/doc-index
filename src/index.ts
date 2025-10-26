import { DocIndexConfig, IndexRepositoryOptions, IndexDocumentationOptions, SearchOptions, SearchResult, Resource } from './types';
import { indexRepository } from './github';
import { indexDocumentation } from './firecrawl';
import { searchCodebase, searchDocumentation, listCodeRepositories, listDocumentationSources } from './search';
import { getOrCreateIndex } from './pinecone';
import { getEmbeddingDimensions } from './openai';

export class DocIndexSDK {
  private openaiKey: string;
  private pineconeKey: string;
  private indexName: string;
  private firecrawlKey: string | undefined;
  private githubToken: string | undefined;

  constructor(config: DocIndexConfig) {
    this.openaiKey = config.openaiKey;
    this.pineconeKey = config.pineconeKey;
    this.indexName = config.pineconeIndexName || 'doc-index';
    this.firecrawlKey = config.firecrawlKey;
    this.githubToken = config.githubToken;
  }

  async indexRepository(
    repoUrl: string,
    options: IndexRepositoryOptions = {},
    onProgress?: (current: number, total: number) => void
  ): Promise<string> {
    if (!this.githubToken) {
      throw new Error('GitHub token is required for indexing repositories');
    }
    
    return await indexRepository(
      this.openaiKey,
      this.pineconeKey,
      this.githubToken,
      this.indexName,
      repoUrl,
      options,
      onProgress
    );
  }

  async searchCodebase(
    query: string,
    repositories?: string[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    return await searchCodebase(
      this.openaiKey,
      this.pineconeKey,
      this.indexName,
      query,
      repositories,
      options
    );
  }

  async indexDocumentation(
    url: string,
    options: IndexDocumentationOptions = {},
    onProgress?: (current: number, total: number) => void
  ): Promise<string> {
    if (!this.firecrawlKey) {
      throw new Error('Firecrawl API key is required for indexing documentation');
    }
    
    return await indexDocumentation(
      this.openaiKey,
      this.pineconeKey,
      this.firecrawlKey,
      this.indexName,
      url,
      options,
      onProgress
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

