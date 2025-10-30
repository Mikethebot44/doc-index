import { generateEmbedding, getEmbeddingDimensions } from './openai';
import { getOrCreateIndex, queryVectors, normalizeNamespace } from './pinecone';
import { getResources as getResourcesFromIndex } from './resource-manager';
import { SearchResult, SearchOptions, Resource } from './types';

export async function searchDocumentation(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  sources?: string[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const normalizedNamespace = normalizeNamespace(options.namespace);
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
    Object.keys(filter).length > 0 ? filter : undefined,
    normalizedNamespace
  );

  return matches.map(match => ({
    id: match.id as string,
    score: match.score || 0,
    metadata: match.metadata as any,
  }));
}

export async function searchDocumentationGrouped(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  options: SearchOptions & { returnPage?: boolean; perPageLimit?: number } = {}
) {
  const namespace = normalizeNamespace(options.namespace);
  const results = await searchDocumentation(
    openaiKey,
    pineconeKey,
    indexName,
    query,
    undefined,
    { ...options, namespace }
  );
  const perPageLimit = options.perPageLimit ?? 5;

  const byUrl = new Map<string, { url: string; score: number; hits: SearchResult[] }>();
  for (const r of results) {
    const url = (r.metadata as any).url as string;
    if (!url) continue;
    const g = byUrl.get(url) || { url, score: 0, hits: [] as SearchResult[] };
    g.hits.push(r);
    g.score = Math.max(g.score, r.score);
    byUrl.set(url, g);
  }

  const pages = [...byUrl.values()].sort((a, b) => b.score - a.score);

  if (!options.returnPage) {
    return pages.map(p => ({
      url: p.url,
      score: p.score,
      snippets: p.hits.slice(0, perPageLimit).map(h => (h.metadata as any).content),
    }));
  }

  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  const assembled: Array<{ url: string; score: number; page: string }> = [];
  for (const p of pages) {
    const all = await queryVectors(index, Array(3072).fill(0), 10000, { url: { $eq: p.url } }, namespace);
    all.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    const pageMarkdown = all.map((m: any) => (m.metadata as any).content).join('\n\n');
    assembled.push({ url: p.url, score: p.score, page: pageMarkdown });
  }
  return assembled;
}

export async function listDocumentationSources(
  pineconeKey: string,
  indexName: string,
  status?: 'indexing' | 'ready' | 'error',
  namespace?: string
): Promise<Resource[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  const resources = await getResourcesFromIndex(index, namespace);
  let filtered = resources.filter(r => r.type === 'doc');

  if (status) {
    filtered = filtered.filter(r => r.status === status);
  }
  
  return filtered;
}
