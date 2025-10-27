import { generateText, tool, jsonSchema } from 'ai';
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
      type: 'string',
      description: 'Specification prompt guiding the crawl (optional).',
      minLength: 1,
    },
    includePaths: {
      type: 'array',
      description: 'Only crawl URLs containing these substrings.',
      items: { type: 'string', minLength: 1 },
    },
    excludePaths: {
      type: 'array',
      description: 'Exclude URLs containing these substrings.',
      items: { type: 'string', minLength: 1 },
    },
    maxPages: {
      type: 'integer',
      description: 'Maximum number of pages to crawl.',
      minimum: 1,
      maximum: 1000,
    },
  },
  required: ['url'],
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
      type: 'integer',
      description: 'Maximum number of results to return.',
      minimum: 1,
      maximum: 20,
    },
    grouped: {
      type: 'boolean',
      description: 'Group matches by page URL before returning.',
    },
    returnPage: {
      type: 'boolean',
      description: 'Include the reconstructed page markdown in grouped responses.',
    },
  },
  required: ['query'],
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
      type: 'integer',
      description: 'Maximum number of URLs to return.',
      minimum: 1,
      maximum: 20,
    },
    includeGithub: {
      type: 'boolean',
      description: 'Include GitHub repositories and discussions.',
    },
    includeResearch: {
      type: 'boolean',
      description: 'Include academic or research sources.',
    },
    includePdf: {
      type: 'boolean',
      description: 'Include PDF documents when available.',
    },
  },
  required: ['query'],
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
      type: 'integer',
      description: 'Number of top pages to include in the summary.',
      minimum: 1,
      maximum: 10,
    },
    model: {
      type: 'string',
      description: 'Override the default model for summarization.',
      minLength: 1,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const listResourcesParameters = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      description: 'Maximum number of resources to include.',
      minimum: 1,
      maximum: 50,
    },
  },
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
      execute: async ({ url, prompt, includePaths, excludePaths, maxPages }) => {
        try {
          try {
            new URL(url);
          } catch {
            return {
              error: `Invalid URL provided: ${url}`,
            };
          }
          const resourceId = await sdk.indexDocumentation(url, {
            prompt,
            includePaths: includePaths ?? undefined,
            excludePaths: excludePaths ?? undefined,
            maxPages: maxPages ?? undefined,
          });
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
      execute: async ({ query, limit, grouped, returnPage }) => {
        const cappedLimit = limit ?? 5;
        try {
          if (grouped || returnPage) {
            const results = await sdk.searchDocumentationGrouped(query, {
              limit: cappedLimit,
              returnPage: Boolean(returnPage),
            });
            return {
              type: 'grouped',
              results: formatGroupedResults(results as any[], cappedLimit, Boolean(returnPage)),
            };
          }
          const results = await sdk.searchDocumentation(query, undefined, {
            limit: cappedLimit,
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
      execute: async ({ query, limit, includeGithub, includeResearch, includePdf }) => {
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
      execute: async ({ query, topPages, model: summaryModel }) => {
        try {
          const summary = await sdk.summarizeDocumentation(query, {
            topPages: topPages ?? 3,
            model: summaryModel,
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
      execute: async ({ limit }) => {
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

  const response = await generateText({
    model: openai(model) as any,
    temperature,
    messages,
    tools,
    maxToolRoundtrips,
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error('Agent returned an empty response.');
  }
  return text;
}
