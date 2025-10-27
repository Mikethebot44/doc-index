import { chunkMarkdownSmart, TextChunk } from './chunking';
import { generateEmbeddings, splitTextToTokenLimit } from './openai';
import { upsertVectors, getOrCreateIndex } from './pinecone';
import { retry } from './utils/retry';
import { addResource, updateResource } from './resource-manager';
import { VectorRecord, Resource, IndexDocumentationOptions } from './types';
import { getEmbeddingDimensions } from './openai';

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';

type CrawlDocument = {
  url?: string;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  metadata?: { sourceURL?: string };
};

type CrawlStartResponse = {
  id?: string;
  success?: boolean;
  error?: string;
  message?: string;
  details?: unknown;
};

type CrawlStatusResponse = {
  status: string;
  data?: CrawlDocument[];
  next?: string;
  error?: string;
  details?: unknown;
};

const PENDING_STATUSES = new Set(['pending', 'queued', 'active', 'scraping', 'waiting', 'paused']);

export async function indexDocumentation(
  openaiKey: string,
  pineconeKey: string,
  firecrawlKey: string,
  indexName: string,
  url: string,
  options: IndexDocumentationOptions = {},
  progressCallback?: (progress: { current: number; total: number }) => void
): Promise<string> {
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
    const crawlData = await retry(
      async () => {
        const crawlId = await startFirecrawlJob(firecrawlKey, url, options);
        return await pollFirecrawlJob(firecrawlKey, crawlId, 2);
      }
    );

    if (!Array.isArray(crawlData) || crawlData.length === 0) {
      throw new Error('No content returned from Firecrawl');
    }

    const docs = crawlData;

    // Build per-page chunks and log scrape events
    const pages: Array<{ url: string; content: string; chunks: TextChunk[] }> = [];
    for (const doc of docs) {
      const pageUrl = doc.url || doc.metadata?.sourceURL || url;
      const content = doc.markdown || doc.html || doc.rawHtml || '';
      if (!content || typeof content !== 'string') continue;
      const chunks = await chunkMarkdownSmart(openaiKey, content, {
        minTokens: 500,
        targetTokens: 1200,
        maxTokens: 1800,
        similarityDrop: 0.2,
      });
      console.log(`Scraped: ${pageUrl}`);
      pages.push({ url: pageUrl, content, chunks });
    }

    const totalChunks = pages.reduce((sum, p) => sum + p.chunks.length, 0);
    if (totalChunks === 0) {
      throw new Error('No content returned from Firecrawl');
    }

    resource.totalChunks = totalChunks;
    await updateResource(index, resourceId, { totalChunks });

    // Index per page to emit granular logs
    let processed = 0;
    for (const page of pages) {
      if (page.chunks.length === 0) continue;
      // Page-level vector (anchor) from first token-safe slice of full page
      const pageSlices = await splitTextToTokenLimit(openaiKey, page.content, 8192);
      if (pageSlices.length > 0) {
        const pageVec = await generateEmbeddings(openaiKey, [pageSlices[0]]);
        await upsertVectors(index, [{
          id: `${resourceId}:${page.url}:page`,
          values: pageVec[0],
          metadata: {
            type: 'doc',
            level: 'page',
            resourceId,
            resourceName,
            url: page.url,
            content: pageSlices[0],
            indexed: Date.now(),
          },
        }]);
      }
      // Token-aware sub-splitting per chunk to stay under model limit
      const tokenSafeTexts: string[] = [];
      for (const chunk of page.chunks) {
        const parts = await splitTextToTokenLimit(openaiKey, chunk.text, 8192);
        tokenSafeTexts.push(...parts);
      }
      const pageEmbeddings = await generateEmbeddings(openaiKey, tokenSafeTexts);
      const vectors: VectorRecord[] = tokenSafeTexts.map((text, i) => ({
        id: `${resourceId}:${page.url}:chunk:${i}`,
        values: pageEmbeddings[i],
        metadata: {
          type: 'doc',
          resourceId,
          resourceName,
          url: page.url,
          content: text,
          indexed: Date.now(),
        },
      }));
      await upsertVectors(index, vectors);
      processed += tokenSafeTexts.length;
      await updateResource(index, resourceId, { chunksProcessed: processed, updatedAt: Date.now() });
      console.log(`Indexed: ${page.url} (${tokenSafeTexts.length} chunks)`);
      if (progressCallback) progressCallback({ current: processed, total: totalChunks });
    }

    await updateResource(index, resourceId, { status: 'ready', updatedAt: Date.now() });
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

async function startFirecrawlJob(
  apiKey: string,
  targetUrl: string,
  options: IndexDocumentationOptions
): Promise<string> {
  const limit = Number.isFinite(options.maxPages) ? options.maxPages : 100;
  const prompt = options.prompt?.trim();
  const payload: Record<string, unknown> = {
    sitemap: "skip",
    url: targetUrl,
    crawlEntireDomain: false,
    limit,
    prompt: prompt && prompt.length > 0 ? prompt : undefined,
    includePaths: options.includePaths?.length ? options.includePaths : undefined,
    excludePaths: options.excludePaths?.length ? options.excludePaths : undefined,
    scrapeOptions: {
      formats: ['markdown'],
      onlyMainContent: true,
    },
  };

  // Remove undefined entries to avoid API rejections
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  const response = await firecrawlRequest<CrawlStartResponse>(apiKey, '/crawl', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!response?.id) {
    const reason = response?.error || response?.message || 'Unknown error';
    throw new Error(`Failed to start Firecrawl job: ${reason}`);
  }

  return response.id;
}

async function pollFirecrawlJob(
  apiKey: string,
  crawlId: string,
  pollSeconds: number
): Promise<CrawlDocument[]> {
  let nextUrl: string | undefined;
  const collected: CrawlDocument[] = [];

  while (true) {
    const statusPath = nextUrl ?? `/crawl/${crawlId}`;
    const status = await firecrawlRequest<CrawlStatusResponse>(apiKey, statusPath, {
      method: 'GET',
    });

    if (!status) {
      throw new Error('Firecrawl returned an empty status response');
    }

    if (status.status === 'completed') {
      if (Array.isArray(status.data)) {
        collected.push(...status.data);
      }

      if (status.next) {
        nextUrl = status.next;
        continue;
      }

      return collected;
    }

    if (PENDING_STATUSES.has(status.status)) {
      await sleep(Math.max(pollSeconds, 2) * 1000);
      nextUrl = undefined;
      continue;
    }

    const reason = status.error || `status=${status.status}`;
    throw new Error(`Firecrawl job failed: ${reason}`);
  }
}

async function firecrawlRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const endpoint = path.startsWith('http') ? path : `${FIRECRAWL_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(endpoint, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const text = await response.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // leave json undefined, fallback to text in error below
  }

  if (!response.ok) {
    const details = json?.details ? ` Details: ${JSON.stringify(json.details)}` : '';
    const message = json?.error || json?.message || text || response.statusText;
    throw new Error(`Firecrawl request failed (${response.status}): ${message}${details}`);
  }

  return json as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
