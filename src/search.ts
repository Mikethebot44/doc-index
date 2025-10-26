import { generateEmbedding, getEmbeddingDimensions } from './openai';
import { getOrCreateIndex, queryVectors } from './pinecone';
import { getResources as getResourcesFromIndex } from './resource-manager';
import { SearchResult, SearchOptions, Resource } from './types';

export async function searchCodebase(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  repositories?: string[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  
  const queryEmbedding = await generateEmbedding(openaiKey, query);
  
  const filter: Record<string, any> = {
    type: { $eq: 'code' },
  };
  
  if (options.filter?.resourceId && options.filter.resourceId.length > 0) {
    filter.resourceId = { $in: options.filter.resourceId };
  } else if (repositories) {
    filter.resourceId = { $in: repositories };
  }
  
  if (options.filter?.language) {
    filter.language = { $in: options.filter.language };
  }
  
  if (options.filter?.filePath) {
    filter.filePath = { $regex: options.filter.filePath };
  }
  
  const matches = await queryVectors(
    index,
    queryEmbedding,
    options.limit || 10,
    Object.keys(filter).length > 0 ? filter : undefined
  );
  
  return matches.map(match => ({
    id: match.id as string,
    score: match.score || 0,
    metadata: match.metadata as any,
  }));
}

export async function searchDocumentation(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  sources?: string[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  
  const queryEmbedding = await generateEmbedding(openaiKey, query);
  
  const filter: Record<string, any> = {
    type: { $eq: 'doc' },
  };
  
  if (options.filter?.resourceId && options.filter.resourceId.length > 0) {
    filter.resourceId = { $in: options.filter.resourceId };
  } else if (sources) {
    filter.resourceId = { $in: sources };
  }
  
  if (options.filter?.url) {
    filter.url = { $regex: options.filter.url };
  }
  
  const matches = await queryVectors(
    index,
    queryEmbedding,
    options.limit || 10,
    Object.keys(filter).length > 0 ? filter : undefined
  );
  
  return matches.map(match => ({
    id: match.id as string,
    score: match.score || 0,
    metadata: match.metadata as any,
  }));
}

export async function listCodeRepositories(
  pineconeKey: string,
  indexName: string,
  status?: 'indexing' | 'ready' | 'error'
): Promise<Resource[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  const resources = await getResourcesFromIndex(index);
  let filtered = resources.filter(r => r.type === 'code');
  
  if (status) {
    filtered = filtered.filter(r => r.status === status);
  }
  
  return filtered;
}

export async function listDocumentationSources(
  pineconeKey: string,
  indexName: string,
  status?: 'indexing' | 'ready' | 'error'
): Promise<Resource[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  const resources = await getResourcesFromIndex(index);
  let filtered = resources.filter(r => r.type === 'doc');
  
  if (status) {
    filtered = filtered.filter(r => r.status === status);
  }
  
  return filtered;
}

