import { streamText, tool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { DocIndexSDK } from './index';
import { AskAgentOptions, FindDocsResult, Resource, SearchResult, VectorMetadata } from './types';

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOOL_ROUNDTRIPS = 4;
const MAX_SNIPPET_LENGTH = 280;
const MAX_PAGE_PREVIEW = 600;

const indexDocsParameters = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'Root documentation URL to fetch and index.',
      minLength: 1,
    },
    prompt: {
      type: ['string', 'null'],
      description: 'Specification prompt guiding the crawl (set to null when not needed).',
      minLength: 1,
    },
    includePaths: {
      type: ['array', 'null'],
      description: 'Only crawl URLs containing these substrings (set to null to disable).',
      items: { type: 'string', minLength: 1 },
    },
    excludePaths: {
      type: ['array', 'null'],
      description: 'Exclude URLs containing these substrings (set to null to disable).',
      items: { type: 'string', minLength: 1 },
    },
    maxPages: {
      type: ['integer', 'null'],
      description: 'Maximum number of pages to crawl (set to null for default).',
      minimum: 1,
      maximum: 1000,
    },
    background: {
      type: ['boolean', 'null'],
      description: 'Run indexing in the background (set to true to queue).',
    },
  },
  required: ['url', 'prompt', 'includePaths', 'excludePaths', 'maxPages', 'background'],
  additionalProperties: false,
} as const;

const searchDocsParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Natural language query describing the desired content.',
      minLength: 1,
    },
    limit: {
      type: ['integer', 'null'],
      description: 'Maximum number of results to return (set to null for default).',
      minimum: 1,
      maximum: 20,
    },
    grouped: {
      type: ['boolean', 'null'],
      description: 'Group matches by page URL before returning (set to null to use default).',
    },
    returnPage: {
      type: ['boolean', 'null'],
      description: 'Include the reconstructed page markdown in grouped responses (set to null to use default).',
    },
  },
  required: ['query', 'limit', 'grouped', 'returnPage'],
  additionalProperties: false,
} as const;

const findDocsParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query for discovering new documentation URLs.',
      minLength: 1,
    },
    limit: {
      type: ['integer', 'null'],
      description: 'Maximum number of URLs to return (set to null for default).',
      minimum: 1,
      maximum: 20,
    },
    includeGithub: {
      type: ['boolean', 'null'],
      description: 'Include GitHub repositories and discussions (set to null to skip).',
    },
    includeResearch: {
      type: ['boolean', 'null'],
      description: 'Include academic or research sources (set to null to skip).',
    },
    includePdf: {
      type: ['boolean', 'null'],
      description: 'Include PDF documents when available (set to null to skip).',
    },
  },
  required: ['query', 'limit', 'includeGithub', 'includeResearch', 'includePdf'],
  additionalProperties: false,
} as const;

const summarizeDocsParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Topic or question to summarize documentation against.',
      minLength: 1,
    },
    topPages: {
      type: ['integer', 'null'],
      description: 'Number of top pages to include in the summary (set to null for default).',
      minimum: 1,
      maximum: 10,
    },
    model: {
      type: ['string', 'null'],
      description: 'Override the default model for summarization (set to null for default).',
      minLength: 1,
    },
  },
  required: ['query', 'topPages', 'model'],
  additionalProperties: false,
} as const;

const listResourcesParameters = {
  type: 'object',
  properties: {
    limit: {
      type: ['integer', 'null'],
      description: 'Maximum number of resources to include (set to null for default).',
      minimum: 1,
      maximum: 50,
    },
  },
  required: ['limit'],
  additionalProperties: false,
} as const;

interface AgentRequest {
  sdk: DocIndexSDK;
  question: string;
  openaiKey: string;
  options: AskAgentOptions;
}

function truncate(text: unknown, maxLength: number): string {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

function formatResourceList(resources: Resource[]): string {
  if (!resources.length) {
    return 'No indexed resources available yet. Index documentation with the indexDocs tool when needed.';
  }
  const lines = resources.slice(0, 10).map(resource => {
    const progress = `${resource.chunksProcessed}/${resource.totalChunks}`;
    return `- ${resource.name} (id: ${resource.id}, status: ${resource.status}, chunks: ${progress})`;
  });
  if (resources.length > 10) {
    lines.push(`- ...and ${resources.length - 10} more resources.`);
  }
  return `Indexed resources:\n${lines.join('\n')}`;
}

function formatFlatResults(results: SearchResult[], limit: number): Array<{
  url?: string;
  score: number;
  snippet: string;
}> {
  return results.slice(0, limit).map(result => {
    const metadata = result.metadata as VectorMetadata;
    return {
      url: metadata.url,
      score: Number(result.score),
      snippet: truncate(metadata.content, MAX_SNIPPET_LENGTH),
    };
  });
}

function formatGroupedResults(results: any[], limit: number, includePage: boolean) {
  return results.slice(0, limit).map(entry => ({
    url: entry.url,
    score: Number(entry.score),
    snippets: Array.isArray(entry.snippets)
      ? entry.snippets.slice(0, 5).map((snippet: string) => truncate(snippet, MAX_SNIPPET_LENGTH))
      : undefined,
    page: includePage && typeof entry.page === 'string'
      ? truncate(entry.page, MAX_PAGE_PREVIEW)
      : undefined,
  }));
}

function formatFindResults(results: FindDocsResult[], limit: number) {
  return results.slice(0, limit).map(result => ({
    url: result.url,
    title: result.title,
    source: result.source,
    score: typeof result.score === 'number' ? Number(result.score) : undefined,
    description: truncate(result.description, MAX_SNIPPET_LENGTH),
  }));
}

function formatResourceSummary(resources: Resource[], limit: number) {
  return resources.slice(0, limit).map(resource => ({
    id: resource.id,
    name: resource.name,
    status: resource.status,
    chunks: `${resource.chunksProcessed}/${resource.totalChunks}`,
    updatedAt: new Date(resource.updatedAt).toISOString(),
  }));
}

export async function runDocIndexAgent({
  sdk,
  question,
  openaiKey,
  options,
}: AgentRequest): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxToolRoundtrips = options.maxToolRoundtrips ?? DEFAULT_MAX_TOOL_ROUNDTRIPS;
  const onToken = options.onToken;
  const rerankEnabled = options.rerankEnabled;
  const rerankModel = options.rerankModel;
  const rerankTopN = options.rerankTopN;

  let resourceContext = '';
  if (options.includeResourceList) {
    try {
      const resources = await sdk.listResources();
      resourceContext = `\n\n${formatResourceList(resources)}`;
    } catch (error) {
      resourceContext = `\n\nUnable to list resources: ${formatError(error)}.`;
    }
  }

  const openai = createOpenAI({ apiKey: openaiKey });

  const tools = {
    indexDocs: tool({
      description: 'Index new documentation into the vector store. Prefer this when the user requests indexing or when required info is missing.',
      parameters: jsonSchema(indexDocsParameters),
      execute: async rawArgs => {
        const {
          url,
          prompt,
          includePaths,
          excludePaths,
          maxPages,
          background,
        } = rawArgs as {
          url: string;
          prompt: string | null;
          includePaths: string[] | null;
          excludePaths: string[] | null;
          maxPages: number | null;
          background: boolean | null;
        };
        try {
          const normalizedPrompt =
            typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : undefined;
          const normalizedIncludePaths = Array.isArray(includePaths) ? includePaths : undefined;
          const normalizedExcludePaths = Array.isArray(excludePaths) ? excludePaths : undefined;
          const normalizedMaxPages = typeof maxPages === 'number' ? maxPages : undefined;
          const runInBackground = Boolean(background);
          try {
            new URL(url);
          } catch {
            return {
              error: `Invalid URL provided: ${url}`,
            };
          }
          const requestOptions = {
            prompt: normalizedPrompt,
            includePaths: normalizedIncludePaths,
            excludePaths: normalizedExcludePaths,
            maxPages: normalizedMaxPages,
          };
          if (runInBackground) {
            const job = await sdk.enqueueIndexDocumentation(url, requestOptions);
            return {
              message: `Queued background indexing job ${job.id} for ${url}`,
              resourceId: job.resourceId,
              jobId: job.id,
            };
          }
          const resourceId = await sdk.indexDocumentation(url, requestOptions);
          return {
            message: `Indexed ${url}`,
            resourceId,
          };
        } catch (error) {
          return {
            error: `Failed to index ${url}: ${formatError(error)}`,
          };
        }
      },
    }),
    searchDocs: tool({
      description: 'Search previously indexed documentation using semantic retrieval.',
      parameters: jsonSchema(searchDocsParameters),
      execute: async rawArgs => {
        const { query, limit, grouped, returnPage } = rawArgs as {
          query: string;
          limit: number | null;
          grouped: boolean | null;
          returnPage: boolean | null;
        };
        const cappedLimit = limit ?? 5;
        try {
          const rerankOptions =
            rerankEnabled !== undefined || rerankModel || rerankTopN !== undefined
              ? {
                  rerankEnabled,
                  rerankModel,
                  rerankTopN,
                }
              : undefined;
          if (grouped || returnPage) {
            const results = await sdk.searchDocumentationGrouped(query, {
              limit: cappedLimit,
              returnPage: Boolean(returnPage),
              ...(rerankOptions ?? {}),
            });
            return {
              type: 'grouped',
              results: formatGroupedResults(results as any[], cappedLimit, Boolean(returnPage)),
            };
          }
          const results = await sdk.searchDocumentation(query, undefined, {
            limit: cappedLimit,
            ...(rerankOptions ?? {}),
          });
          return {
            type: 'flat',
            results: formatFlatResults(results as SearchResult[], cappedLimit),
          };
        } catch (error) {
          return {
            error: `Search failed: ${formatError(error)}`,
          };
        }
      },
    }),
    findDocs: tool({
      description: 'Discover fresh documentation URLs from the web via Firecrawl.',
      parameters: jsonSchema(findDocsParameters),
      execute: async rawArgs => {
        const { query, limit, includeGithub, includeResearch, includePdf } = rawArgs as {
          query: string;
          limit: number | null;
          includeGithub: boolean | null;
          includeResearch: boolean | null;
          includePdf: boolean | null;
        };
        try {
          const results = await sdk.findDocs(query, {
            limit: limit ?? 5,
            includeGithub: includeGithub ?? false,
            includeResearch: includeResearch ?? false,
            includePdf: includePdf ?? false,
          });
          return {
            results: formatFindResults(results, limit ?? 5),
          };
        } catch (error) {
          return {
            error: `Failed to find documentation: ${formatError(error)}`,
          };
        }
      },
    }),
    summarizeDocs: tool({
      description: 'Summarize top matching documentation for a query using the summarize workflow.',
      parameters: jsonSchema(summarizeDocsParameters),
      execute: async rawArgs => {
        const { query, topPages, model: summaryModel } = rawArgs as {
          query: string;
          topPages: number | null;
          model: string | null;
        };
        try {
          const summary = await sdk.summarizeDocumentation(query, {
            topPages: topPages ?? 3,
            model: summaryModel ?? undefined,
            rerankEnabled,
            rerankModel,
            rerankTopN,
          });
          return {
            summary,
          };
        } catch (error) {
          return {
            error: `Failed to summarize documentation: ${formatError(error)}`,
          };
        }
      },
    }),
    listResources: tool({
      description: 'List indexed documentation resources with statuses.',
      parameters: jsonSchema(listResourcesParameters),
      execute: async rawArgs => {
        const { limit } = rawArgs as { limit: number | null };
        try {
          const resources = await sdk.listResources();
          return {
            resources: formatResourceSummary(resources, limit ?? 20),
          };
        } catch (error) {
          return {
            error: `Failed to list resources: ${formatError(error)}`,
          };
        }
      },
    }),
  };

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    {
      role: 'system',
      content:
        'You are the Doc Index AI agent. Use the provided tools to answer user questions about documentation. ' +
        'Search existing resources first, and only index new documentation when it is necessary or requested. ' +
        'Cite relevant URLs in your answers and describe the steps clearly.' +
        resourceContext,
    },
    {
      role: 'user',
      content: question,
    },
  ];

  const response = await streamText({
    model: openai(model) as any,
    temperature,
    messages,
    tools,
    maxToolRoundtrips,
  });

  let streamedText = '';
  for await (const chunk of response.textStream) {
    streamedText += chunk;
    if (typeof onToken === 'function' && chunk) {
      onToken(chunk);
    }
  }

  const finalText = (streamedText || await response.text).trim();
  if (!finalText) {
    throw new Error('Agent returned an empty response.');
  }
  return finalText;
}
