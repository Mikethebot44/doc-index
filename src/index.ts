import { fork } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  DocIndexConfig,
  IndexDocumentationOptions,
  SearchOptions,
  SearchResult,
  Resource,
  FindDocsOptions,
  FindDocsResult,
  AskAgentOptions,
  IndexJob,
} from './types';
import { indexDocumentation, searchFirecrawlUrls } from './firecrawl';
import { searchDocumentation, searchDocumentationGrouped } from './search';
import { getOrCreateIndex } from './pinecone';
import { getEmbeddingDimensions, splitTextToTokenLimit } from './openai';
import {
  listJobs as loadJobs,
  getJob as loadJob,
  upsertJob,
  updateJob as patchJob,
  appendJobLog,
} from './job-store';

const workerModulePath = resolveWorkerModulePath();

function resolveCurrentDir(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

function resolveWorkerModulePath(): string {
  const currentDir = resolveCurrentDir();
  const candidates = ['background-worker.js', 'background-worker.cjs', 'background-worker.mjs'];
  for (const candidate of candidates) {
    const candidatePath = join(currentDir, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return join(currentDir, 'background-worker.js');
}

function formatJobError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function generateJobId(): string {
  try {
    return `job_${randomUUID()}`;
  } catch {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function sanitizeIndexOptions(options: IndexDocumentationOptions = {}): IndexDocumentationOptions {
  const sanitized: IndexDocumentationOptions = {};
  if (typeof options.maxPages === 'number' && Number.isFinite(options.maxPages)) {
    sanitized.maxPages = options.maxPages;
  }
  if (typeof options.prompt === 'string') {
    sanitized.prompt = options.prompt;
  }
  if (Array.isArray(options.includePaths)) {
    sanitized.includePaths = [...options.includePaths];
  }
  if (Array.isArray(options.excludePaths)) {
    sanitized.excludePaths = [...options.excludePaths];
  }
  return sanitized;
}

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
    onProgress?: (current: number, total: number) => void,
    onLog?: (message: string, level?: 'info' | 'error') => void
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
      wrappedProgress,
      onLog
    );
  }

  async enqueueIndexDocumentation(
    url: string,
    options: IndexDocumentationOptions = {}
  ): Promise<IndexJob> {
    if (!this.firecrawlKey) {
      throw new Error('Firecrawl API key is required for indexing documentation');
    }

    const jobId = generateJobId();
    const resourceId = `doc:${url}`;
    const sanitizedOptions = sanitizeIndexOptions(options);
    const now = Date.now();

    const job: IndexJob = {
      id: jobId,
      resourceId,
      url,
      options: sanitizedOptions,
      status: 'queued',
      progress: { current: 0, total: 0 },
      createdAt: now,
      updatedAt: now,
      logs: [],
    };

    await upsertJob(job);
    await appendJobLog(jobId, `Queued background indexing for ${url}`);

    try {
      this.spawnBackgroundWorker(job);
    } catch (error) {
      const message = formatJobError(error);
      await patchJob(jobId, { status: 'failed', error: message });
      await appendJobLog(jobId, `Failed to launch background worker: ${message}`, 'error');
      throw new Error(`Failed to start background index job: ${message}`);
    }

    return job;
  }

  async listIndexJobs(): Promise<IndexJob[]> {
    return await loadJobs();
  }

  async getIndexJob(jobId: string): Promise<IndexJob | undefined> {
    if (!jobId) {
      return undefined;
    }
    return await loadJob(jobId);
  }

  private spawnBackgroundWorker(job: IndexJob): void {
    const envConfig = JSON.stringify({
      openaiKey: this.openaiKey,
      pineconeKey: this.pineconeKey,
      pineconeIndexName: this.indexName,
      firecrawlKey: this.firecrawlKey,
    });

    const child = fork(workerModulePath, [], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        DOC_INDEX_JOB_ID: job.id,
        DOC_INDEX_CONFIG: envConfig,
      },
    });

    child.on('error', error => {
      const message = formatJobError(error);
      void patchJob(job.id, {
        status: 'failed',
        error: message,
      });
      void appendJobLog(job.id, `Background worker error: ${message}`, 'error');
    });

    child.on('exit', code => {
      if (typeof code === 'number' && code !== 0) {
        const message = `Background worker exited with code ${code}`;
        void patchJob(job.id, {
          status: 'failed',
          error: message,
        });
        void appendJobLog(job.id, message, 'error');
      }
    });

    child.unref();
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

