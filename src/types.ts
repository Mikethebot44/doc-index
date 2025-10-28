export type VectorType = 'doc';

export interface VectorMetadata {
  type: VectorType;
  resourceId: string;
  resourceName: string;
  content: string;
  url?: string;
  level?: 'page' | 'chunk';
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
  type: VectorType;
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
}

export interface IndexDocumentationOptions {
  maxPages?: number;
  prompt?: string;
  includePaths?: string[];
  excludePaths?: string[];
}

export type IndexJobStatus = 'queued' | 'in-progress' | 'completed' | 'failed';

export interface IndexJobProgress {
  current: number;
  total: number;
}

export interface IndexJobLogEntry {
  timestamp: number;
  level: 'info' | 'error';
  message: string;
}

export interface IndexJob {
  id: string;
  resourceId: string;
  url: string;
  options: IndexDocumentationOptions;
  status: IndexJobStatus;
  progress: IndexJobProgress;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  logs: IndexJobLogEntry[];
}

export interface SearchOptions {
  limit?: number;
  filter?: {
    resourceId?: string[];
    url?: string;
  };
}

export interface FindDocsOptions {
  limit?: number;
  includeGithub?: boolean;
  includeResearch?: boolean;
  includePdf?: boolean;
}

export interface FindDocsResult {
  url: string;
  title?: string;
  description?: string;
  source?: string;
  score?: number;
}

export interface AskAgentOptions {
  model?: string;
  temperature?: number;
  maxToolRoundtrips?: number;
  includeResourceList?: boolean;
  onToken?: (chunk: string) => void;
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

