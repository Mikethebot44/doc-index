import { generateEmbedding, generateClipEmbedding, getEmbeddingDimensions, getClipEmbeddingDimensions } from './openai';
import { getOrCreateIndex, queryVectors, normalizeNamespace, rerankMatches } from './pinecone';
import { getResources as getResourcesFromIndex } from './resource-manager';
import { SearchResult, SearchOptions, Resource, VectorMetadata } from './types';

function ensureMetadata(metadata?: VectorMetadata): VectorMetadata {
  if (metadata) return metadata;
  return {
    type: 'doc',
    resourceId: 'unknown',
    resourceName: 'unknown',
    content: '',
    indexed: 0,
  };
}

export async function searchDocumentation(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  sources?: string[],
  options: SearchOptions = {},
  extra?: { imageIndexName?: string }
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

  // Optionally rerank using Pinecone hosted Cohere Rerank 3.5
  let results: SearchResult[] = matches.map(match => {
    const rawMetadata = match.metadata as VectorMetadata | undefined;
    const metadata: VectorMetadata = ensureMetadata(rawMetadata);
    return {
      id: match.id as string,
      score: match.score || 0,
      metadata,
    } as SearchResult;
  });

  const rerankEnabled = options.rerankEnabled !== false; // default true
  if (rerankEnabled && results.length > 0) {
    const rerankTopN = Math.min(options.rerankTopN ?? results.length, results.length);
    const reranked = await rerankMatches(
      pineconeKey,
      query,
      results,
      { model: options.rerankModel || 'cohere-rerank-3.5', topN: rerankTopN }
    );
    // Sort by reranked score desc and then slice to requested limit
    const sanitized = reranked.map(match => ({
      id: match.id,
      score: match.score ?? 0,
      metadata: ensureMetadata(match.metadata as VectorMetadata | undefined),
    }));
    results = sanitized.sort((a, b) => b.score - a.score).slice(0, options.limit || 10);
  }

  const limit = options.limit || 10;
  const imageIndexName = extra?.imageIndexName;
  if (!imageIndexName) {
    return results;
  }

  const imageResults = await searchImageVectors(
    openaiKey,
    pineconeKey,
    imageIndexName,
    query,
    limit,
    normalizedNamespace,
    sources,
    options
  );

  if (imageResults.length === 0) {
    return results;
  }

  return fuseModalityResults(results, imageResults, limit);
}

export async function searchImageVectors(
  openaiKey: string,
  pineconeKey: string,
  indexName: string,
  query: string,
  limit: number,
  namespace: string,
  sources: string[] | undefined,
  options: SearchOptions
): Promise<SearchResult[]> {
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getClipEmbeddingDimensions()
  );

  const queryEmbedding = await generateClipEmbedding(openaiKey, query);

  const filter: Record<string, any> = {
    modality: { $eq: 'image' },
  };

  if (options.filter?.resourceId && options.filter.resourceId.length > 0) {
    filter.resourceId = { $in: options.filter.resourceId };
  } else if (sources && sources.length > 0) {
    filter.resourceId = { $in: sources };
  }

  if (options.filter?.url) {
    filter.url = { $regex: options.filter.url };
  }

  const matches = await queryVectors(
    index,
    queryEmbedding,
    limit,
    Object.keys(filter).length > 0 ? filter : undefined,
    namespace
  );

  return matches.map(match => {
    const metadata = ensureMetadata(match.metadata as VectorMetadata | undefined);
    return {
      id: match.id as string,
      score: match.score || 0,
      metadata: {
        ...metadata,
        modality: metadata.modality ?? 'image',
        contentType: metadata.contentType ?? 'image',
      },
    } as SearchResult;
  });
}

function fuseModalityResults(
  textResults: SearchResult[],
  imageResults: SearchResult[],
  limit: number
): SearchResult[] {
  if (imageResults.length === 0) {
    return textResults.slice(0, limit);
  }
  if (textResults.length === 0) {
    return imageResults.slice(0, limit).map(result => ({ ...result }));
  }

  const textNorm = normalizeScores(textResults);
  const imageNorm = normalizeScores(imageResults);
  const textConfidence = computeConfidence(textNorm);
  const imageConfidence = computeConfidence(imageNorm);
  const { textWeight, imageWeight } = computeModalityWeights(
    textResults.length > 0,
    imageResults.length > 0,
    textConfidence,
    imageConfidence
  );

  const combined = new Map<string, { result: SearchResult; fusedScore: number }>();

  for (const result of textResults) {
    const normalized = textNorm.get(result.id) ?? 0;
    const fusedScore = textWeight * normalized;
    combined.set(result.id, {
      result: { ...result, score: fusedScore },
      fusedScore,
    });
  }

  for (const result of imageResults) {
    const normalized = imageNorm.get(result.id) ?? 0;
    const additionalScore = imageWeight * normalized;
    const existing = combined.get(result.id);
    if (existing) {
      const fusedScore = existing.fusedScore + additionalScore;
      // Prefer metadata with richer content (prioritise text result if present)
      const updatedResult =
        existing.result.metadata.modality === 'image' && result.metadata.modality !== 'image'
          ? { ...result, score: fusedScore }
          : { ...existing.result, score: fusedScore };
      combined.set(result.id, {
        result: updatedResult,
        fusedScore,
      });
    } else {
      combined.set(result.id, {
        result: { ...result, score: additionalScore },
        fusedScore: additionalScore,
      });
    }
  }

  return Array.from(combined.values())
    .map(entry => ({ ...entry.result, score: entry.fusedScore }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizeScores(results: SearchResult[]): Map<string, number> {
  const normalized = new Map<string, number>();
  if (results.length === 0) {
    return normalized;
  }
  const scores = results.map(r => r.score ?? 0);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const denominator = maxScore - minScore;
  for (const result of results) {
    let value = result.score ?? 0;
    if (denominator === 0) {
      value = maxScore !== 0 ? 1 : 0;
    } else {
      value = (value - minScore) / denominator;
    }
    normalized.set(result.id, value);
  }
  return normalized;
}

function computeConfidence(normalizedScores: Map<string, number>, topK = 5): number {
  if (normalizedScores.size === 0) {
    return 0;
  }
  const sorted = [...normalizedScores.values()].sort((a, b) => b - a);
  const k = Math.min(topK, sorted.length);
  if (k === 0) {
    return 0;
  }
  const sum = sorted.slice(0, k).reduce((acc, value) => acc + value, 0);
  return sum / k;
}

function computeModalityWeights(
  hasTextResults: boolean,
  hasImageResults: boolean,
  textConfidence: number,
  imageConfidence: number
): { textWeight: number; imageWeight: number } {
  if (!hasTextResults && !hasImageResults) {
    return { textWeight: 0.5, imageWeight: 0.5 };
  }
  if (!hasTextResults) {
    return { textWeight: 0, imageWeight: 1 };
  }
  if (!hasImageResults) {
    return { textWeight: 1, imageWeight: 0 };
  }
  const weights = softmax([textConfidence, imageConfidence]);
  return { textWeight: weights[0], imageWeight: weights[1] };
}

function softmax(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values);
  const expValues = values.map(value => Math.exp(value - max));
  const sum = expValues.reduce((acc, value) => acc + value, 0);
  if (sum === 0) {
    const uniform = 1 / values.length;
    return values.map(() => uniform);
  }
  return expValues.map(value => value / sum);
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
    const pageMarkdown = all
      .filter((m: any) => (m.metadata as any).level !== 'file')
      .map((m: any) => (m.metadata as any).content)
      .join('\n\n');
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
