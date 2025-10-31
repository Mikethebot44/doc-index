import { generateEmbedding } from './openai';
import { queryVectors, normalizeNamespace } from './pinecone';
import {
  RepoGranularity,
  RepoSearchMatch,
  SearchCodebaseOptions,
  SearchCodebaseResult,
  VectorMetadata,
} from './types';

function toRepoSearchMatch(match: any): RepoSearchMatch | undefined {
  if (!match || !match.metadata) {
    return undefined;
  }

  const metadata = match.metadata as VectorMetadata & {
    path?: string;
    repo?: string;
    branch?: string;
    language?: string;
    symbol?: string;
    granularity?: RepoGranularity;
  };

  if (metadata.type !== 'repo') {
    return undefined;
  }

  const granularity = metadata.granularity ?? 'file';
  const contentPreview = typeof metadata.content === 'string'
    ? metadata.content.slice(0, 400)
    : '';

  return {
    id: match.id,
    granularity,
    score: typeof match.score === 'number' ? match.score : 0,
    path: metadata.path ?? '',
    repo: metadata.repo ?? (metadata.resourceName ?? ''),
    branch: metadata.branch,
    language: metadata.language,
    symbol: metadata.symbol,
    url: metadata.url,
    preview: contentPreview,
    primaryPurpose: metadata.primaryPurpose,
    architectureRole: metadata.architectureRole,
    complexity: metadata.complexity,
  };
}

export async function searchRepositoryCodebase(
  params: {
    index: any;
    namespace: string;
    query: string;
    openaiKey: string;
    options?: SearchCodebaseOptions;
  }
): Promise<SearchCodebaseResult> {
  const { index, namespace, query, openaiKey, options } = params;

  if (!query || !query.trim()) {
    throw new Error('A non-empty query is required to search the codebase.');
  }

  const normalizedNamespace = normalizeNamespace(namespace);
  const topFileResults = options?.topFileResults && Number.isFinite(options.topFileResults)
    ? Math.max(1, Math.floor(options.topFileResults))
    : 8;
  const topSnippetResults = options?.topSnippetResults && Number.isFinite(options.topSnippetResults)
    ? Math.max(1, Math.floor(options.topSnippetResults))
    : 16;

  const queryEmbedding = await generateEmbedding(openaiKey, query);

  const baseFilter: Record<string, unknown> = {
    type: { $eq: 'repo' },
  };
  if (options?.repo) {
    baseFilter.repo = { $eq: options.repo };
  }

  const [fileMatchesRaw, snippetMatchesRaw] = await Promise.all([
    queryVectors(index, queryEmbedding, topFileResults, { ...baseFilter, granularity: { $eq: 'file' } }, normalizedNamespace),
    queryVectors(index, queryEmbedding, topSnippetResults, { ...baseFilter, granularity: { $eq: 'snippet' } }, normalizedNamespace),
  ]);

  const combined = [...(fileMatchesRaw ?? []), ...(snippetMatchesRaw ?? [])];
  const matches = combined
    .map(toRepoSearchMatch)
    .filter((match): match is RepoSearchMatch => Boolean(match))
    .sort((a, b) => b.score - a.score);

  return {
    query,
    namespace: normalizedNamespace,
    matches,
    topMatch: matches[0],
  };
}
