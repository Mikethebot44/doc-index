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

