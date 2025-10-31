export type VectorType = 'doc' | 'repo';
export type RepoGranularity = 'file' | 'snippet';

export interface VectorMetadata {
  type: VectorType;
  resourceId: string;
  resourceName: string;
  content: string;
  url?: string;
  level?: 'page' | 'chunk' | 'file' | 'snippet';
  indexed: number;
  granularity?: RepoGranularity;
  repo?: string;
  branch?: string;
  path?: string;
  language?: string;
  symbol?: string;
  functions?: string[];
  hash?: string;
  imports?: string[];
  exports?: string[];
  semanticJson?: string;
  primaryPurpose?: string;
  architectureRole?: string;
  dependsOn?: string[];
  interactionType?: string[];
  complexity?: 'low' | 'medium' | 'high' | 'unknown';
  keyEntities?: string[];
  audience?: string;
  topics?: string[];
  hasCodeExamples?: boolean;
  contentType?: string;
  headings?: string[];
  codeLanguages?: string[];
  wordCount?: number;
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
  repo?: string;
  branch?: string;
  fileCount?: number;
  snippetCount?: number;
  enrichedCount?: number;
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
  pineconeNamespace?: string;
  githubToken?: string;
}

export interface CreateNamespaceOptions {
  description?: string;
  placeholderId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateNamespaceResult {
  name: string;
  placeholderId: string;
  created: boolean;
  metadata: Record<string, unknown>;
}

export interface IndexDocumentationOptions {
  maxPages?: number;
  prompt?: string;
  includePaths?: string[];
  excludePaths?: string[];
  namespace?: string;
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

export type IndexJobType = 'docs' | 'repo';

export interface IndexJob {
  id: string;
  type: IndexJobType;
  resourceId: string;
  url?: string;
  repo?: string;
  options: (IndexDocumentationOptions | IndexRepositoryOptions) & { namespace?: string };
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
  namespace?: string;
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
  namespace?: string;
}

export interface IndexRepositoryOptions {
  branch?: string;
  languages?: string[];
  maxFiles?: number;
  maxFileSizeKb?: number;
  namespace?: string;
  enrichMetadata?: boolean;
}

export interface IndexRepositoryResult {
  repo: string;
  branch: string;
  namespace: string;
  filesIndexed: number;
  snippetsIndexed: number;
  skippedFiles: number;
  resourceId: string;
  metadataEnriched: number;
}

export interface SearchCodebaseOptions {
  namespace?: string;
  repo?: string;
  topFileResults?: number;
  topSnippetResults?: number;
}

export interface RepoSearchMatch {
  id: string;
  granularity: RepoGranularity;
  score: number;
  path: string;
  repo: string;
  branch?: string;
  language?: string;
  symbol?: string;
  url?: string;
  preview: string;
  primaryPurpose?: string;
  architectureRole?: string;
  complexity?: string;
}

export interface SearchCodebaseResult {
  query: string;
  namespace: string;
  matches: RepoSearchMatch[];
  topMatch?: RepoSearchMatch;
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

export interface SemanticFileMetadata {
  path: string;
  language: string;
  primaryPurpose: string;
  architectureRole: string;
  dependsOn: string[];
  interactionType: string[];
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  keyEntities: string[];
  exports: string[];
}

export interface SemanticDocumentMetadata {
  url: string;
  path?: string;
  primaryPurpose: string;
  audience: string;
  topics: string[];
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  hasCodeExamples: boolean;
  contentType: string;
  headings: string[];
}

