export interface VectorMetadata {
  type: 'code' | 'doc';
  resourceId: string;
  resourceName: string;
  filePath: string;
  content: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  url?: string;
  indexed: number;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface Resource {
  id: string;
  name: string;
  type: 'code' | 'doc';
  status: 'indexing' | 'ready' | 'error';
  chunksProcessed: number;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export interface DocIndexConfig {
  openaiKey: string;
  pineconeKey: string;
  pineconeIndexName?: string;
  firecrawlKey?: string;
  githubToken?: string;
}

export interface IndexRepositoryOptions {
  branch?: string;
  includePaths?: string[];
  excludePaths?: string[];
}

export interface IndexDocumentationOptions {
  maxPages?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface SearchOptions {
  limit?: number;
  filter?: {
    resourceId?: string[];
    language?: string[];
    filePath?: string;
  };
}

export class DocIndexError extends Error {
  constructor(
    message: string,
    public code?: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'DocIndexError';
  }
}

