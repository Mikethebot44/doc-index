import { Octokit } from '@octokit/core';
import { generateEmbeddings } from './openai';
import { upsertVectors, normalizeNamespace } from './pinecone';
import {
  IndexRepositoryOptions,
  IndexRepositoryResult,
  RepoGranularity,
  VectorRecord,
  Resource,
  SemanticFileMetadata,
} from './types';
import {
  addResource,
  updateResource,
  getResource,
  deleteResource,
  deleteResourceFromPinecone,
} from './resource-manager';
import { generateSemanticFileMetadata, SemanticMetadataInput } from './code-metadata';

type RepoIdentity = {
  owner: string;
  name: string;
  branch: string;
  slug: string;
  resourceId: string;
};

type RepoFile = {
  path: string;
  size: number;
  sha: string;
};

type FileDescriptor = {
  id: string;
  path: string;
  language: string;
  url: string;
  text: string;
  functions: string[];
  imports: string[];
  exports: string[];
  semantic?: SemanticFileMetadata;
};

type SnippetDescriptor = {
  id: string;
  path: string;
  language: string;
  url: string;
  symbol: string;
  text: string;
  granularity: RepoGranularity;
  semantic?: SemanticFileMetadata;
};

const DEFAULT_BRANCH = 'main';
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_FILE_SIZE_KB = 100;
const MAX_SNIPPET_LINES = 32;
const SKIP_PATH_SEGMENTS = ['node_modules', '.git', 'dist', 'build', 'tmp'];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  mm: 'objective-c',
  m: 'objective-c',
  sh: 'shell',
  md: 'markdown',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
};

export class OctokitFetcher {
  private client: Octokit;

  constructor(token: string) {
    this.client = new Octokit({ auth: token });
  }

  async fetchRepoTree(owner: string, repo: string, branch: string): Promise<RepoFile[]> {
    const response = await this.client.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      owner,
      repo,
      tree_sha: branch,
      recursive: 'true',
    });

    const treeItems = Array.isArray((response.data as any)?.tree)
      ? ((response.data as any).tree as Array<{ path?: string; type?: string; size?: number; sha?: string }>)
      : [];

    return treeItems
      .filter(item => item.type === 'blob' && typeof item.path === 'string')
      .map(item => ({
        path: item.path ?? '',
        size: typeof item.size === 'number' ? item.size : 0,
        sha: item.sha ?? '',
      }))
      .filter(file => file.path.length > 0 && file.sha.length > 0);
  }

  async fetchFileContent(owner: string, repo: string, path: string): Promise<string | undefined> {
    try {
      const response = await this.client.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
      });

      const data = response.data as { encoding?: string; content?: string } | Array<unknown>;
      if (!data || Array.isArray(data)) {
        return undefined;
      }

      if (data.encoding !== 'base64' || typeof data.content !== 'string') {
        return undefined;
      }

      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (process.env.DOC_INDEX_DEBUG === '1') {
        console.warn(`Failed to fetch ${path}:`, error);
      }
      return undefined;
    }
  }
}

export function parseGithubRepo(input: string, branch?: string): RepoIdentity {
  const trimmed = input.trim();
  const urlPattern = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([^\s/]+))?/i;
  let owner = '';
  let name = '';
  let resolvedBranch = branch?.trim() || '';

  const urlMatch = trimmed.match(urlPattern);
  if (urlMatch) {
    owner = urlMatch[1];
    name = urlMatch[2];
    if (!resolvedBranch && urlMatch[3]) {
      resolvedBranch = urlMatch[3];
    }
  } else {
    const slugParts = trimmed.replace(/^\s+|\s+$/g, '').split('/');
    if (slugParts.length >= 2) {
      owner = slugParts[0];
      name = slugParts[1];
    }
  }

  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository reference: ${input}`);
  }

  const safeBranch = resolvedBranch || DEFAULT_BRANCH;
  const slug = `${owner}/${name}`;
  return {
    owner,
    name,
    branch: safeBranch,
    slug,
    resourceId: `repo:${slug}`,
  };
}

function shouldSkipPath(path: string): boolean {
  if (!path) return true;
  const segments = path.split('/');
  if (segments.some(segment => SKIP_PATH_SEGMENTS.includes(segment))) {
    return true;
  }
  if (/\.(lock|min\.js|min\.css)$/.test(path)) {
    return true;
  }
  return false;
}

function getExtension(path: string): string {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1]?.toLowerCase() ?? '';
}

function detectLanguage(path: string): string | undefined {
  const extension = getExtension(path);
  return LANGUAGE_BY_EXTENSION[extension];
}

function extractImportModules(content: string): string[] {
  const modules = new Set<string>();
  const importRegex = /import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const fromRegex = /from\s+['"]([^'"]+)['"]/g;

  const addMatch = (match: RegExpExecArray | null) => {
    if (match && typeof match[1] === 'string' && match[1].trim().length > 0) {
      modules.add(match[1].trim());
    }
  };

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) addMatch(match);
  while ((match = requireRegex.exec(content)) !== null) addMatch(match);
  while ((match = fromRegex.exec(content)) !== null) addMatch(match);

  return Array.from(modules).slice(0, 24);
}

function extractExportSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_]+)/g;
  const namedExportRegex = /export\s*{\s*([^}]+)\s*}/g;
  const moduleExportsRegex = /module\.exports\s*=\s*{([^}]+)}/g;

  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(content)) !== null) {
    if (match[1]) symbols.add(match[1]);
  }

  while ((match = namedExportRegex.exec(content)) !== null) {
    const names = match[1]
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/i)[0])
      .filter(Boolean);
    names.forEach(name => symbols.add(name));
  }

  while ((match = moduleExportsRegex.exec(content)) !== null) {
    const names = match[1]
      .split(',')
      .map(part => part.split(':')[0]?.trim())
      .filter(Boolean);
    names.forEach(name => symbols.add(name));
  }

  return Array.from(symbols).slice(0, 32);
}

function extractDocstring(content: string): string | undefined {
  const blockMatch =
    content.match(/\/\*\*[\s\S]{0,400}?\*\//) ||
    content.match(/\/\*[\s\S]{0,400}?\*\//) ||
    content.match(/"""[\s\S]{0,400}?"""/) ||
    content.match(/'''[\s\S]{0,400}?'''/);

  if (blockMatch) {
    return blockMatch[0]
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .replace(/^["']{3}/, '')
      .replace(/["']{3}$/, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*?\s?/, '').trim())
      .join(' ')
      .trim();
  }

  const lines = content.split('\n').slice(0, 10);
  const commentLines = lines
    .map(line => line.trim())
    .filter(line => line.startsWith('//') || line.startsWith('#'))
    .map(line => line.replace(/^\/\/\s?/, '').replace(/^#\s?/, '').trim());

  if (commentLines.length > 0) {
    return commentLines.join(' ').trim();
  }

  return undefined;
}

function summarizeContent(content: string): string {
  const lines = content.split('\n').slice(0, 60);
  return lines.join('\n').trim().slice(0, 1000);
}

function filterByLanguage(path: string, languages: string[] | undefined): boolean {
  if (!languages || languages.length === 0) return true;
  const extension = getExtension(path);
  const normalized = languages.map(lang => lang.trim().toLowerCase());
  return normalized.includes(extension) || normalized.includes(detectLanguage(path) ?? '');
}

function extractSnippets(content: string, language: string): Array<{ name: string; text: string }> {
  const snippets: Array<{ name: string; text: string }> = [];
  if (!content) {
    return snippets;
  }

  const lines = content.split('\n');
  const limit = Math.min(lines.length, 2000);

  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const functionMatch = trimmed.match(/^function\s+([A-Za-z0-9_]+)/);
    const constFunctionMatch = trimmed.match(/^const\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(/);
    const arrowFunctionMatch = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(async\s*)?\(/);
    const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);

    let name: string | undefined;
    if (functionMatch) name = functionMatch[1];
    else if (constFunctionMatch) name = constFunctionMatch[1];
    else if (arrowFunctionMatch) name = arrowFunctionMatch[1];
    else if (classMatch) name = classMatch[1];

    if (!name) continue;

    const start = i;
    const end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
    const block = lines.slice(start, end).join('\n').trim();
    if (!block) continue;
    if (snippets.some(existing => existing.name === name)) continue;

    snippets.push({ name, text: block });
  }

  return snippets;
}

function buildFileDescriptor(
  repo: RepoIdentity,
  path: string,
  language: string,
  snippets: Array<{ name: string; text: string }>,
  options: {
    imports: string[];
    exports: string[];
    docstring?: string;
    semantic?: SemanticFileMetadata;
  }
): FileDescriptor {
  const uniqueFunctions = Array.from(
    new Set([
      ...snippets.map(s => s.name),
      ...options.exports,
    ])
  );

  const textParts: string[] = [
    `Repository: ${repo.slug}`,
    `Branch: ${repo.branch}`,
    `Path: ${path}`,
    `Language: ${language}`,
  ];

  if (options.semantic) {
    textParts.push(
      `Primary purpose: ${options.semantic.primaryPurpose}`,
      `Architecture role: ${options.semantic.architectureRole}`,
      `Complexity: ${options.semantic.complexity}`
    );
    if (options.semantic.dependsOn.length > 0) {
      textParts.push(`Depends on: ${options.semantic.dependsOn.join(', ')}`);
    }
    if (options.semantic.interactionType.length > 0) {
      textParts.push(`Interaction type: ${options.semantic.interactionType.join(', ')}`);
    }
    if (options.semantic.keyEntities.length > 0) {
      textParts.push(`Key entities: ${options.semantic.keyEntities.join(', ')}`);
    }
  } else {
    if (options.docstring) {
      textParts.push(`Comment summary: ${options.docstring}`);
    }
  }

  if (options.imports.length > 0) {
    textParts.push(`Imports: ${options.imports.slice(0, 8).join(', ')}`);
  }
  if (uniqueFunctions.length > 0) {
    textParts.push(`Symbols: ${uniqueFunctions.slice(0, 12).join(', ')}`);
  }

  const descriptor: FileDescriptor = {
    id: `file:${repo.slug}:${path}`,
    path,
    language,
    url: `https://github.com/${repo.slug}/blob/${repo.branch}/${path}`,
    text: textParts.join('\n\n'),
    functions: uniqueFunctions,
    imports: options.imports,
    exports: options.exports,
    semantic: options.semantic,
  };

  return descriptor;
}

function buildSnippetDescriptors(
  repo: RepoIdentity,
  path: string,
  language: string,
  snippets: Array<{ name: string; text: string }>,
  semantic?: SemanticFileMetadata
): SnippetDescriptor[] {
  return snippets.map(snippet => ({
    id: `snippet:${repo.slug}:${path}#${snippet.name}`,
    path,
    language,
    url: `https://github.com/${repo.slug}/blob/${repo.branch}/${path}#L1`,
    symbol: snippet.name,
    text: [
      `Repository: ${repo.slug}`,
      `Path: ${path}`,
      `Language: ${language}`,
      `Symbol: ${snippet.name}`,
      semantic ? `File purpose: ${semantic.primaryPurpose}` : '',
      'Definition:',
      snippet.text,
    ]
      .filter(Boolean)
      .join('\n\n'),
    granularity: 'snippet' as RepoGranularity,
    semantic,
  }));
}

export async function indexGithubRepository(
  params: {
    index: any;
    namespace: string;
    repo: string;
    openaiKey: string;
    githubToken: string;
    options?: IndexRepositoryOptions;
    onProgress?: (current: number, total: number) => void;
    onLog?: (message: string, level?: 'info' | 'error') => void;
  }
): Promise<IndexRepositoryResult> {
  const { index, namespace, repo, openaiKey, githubToken, options, onProgress, onLog } = params;
  const normalizedNamespace = normalizeNamespace(namespace);
  const repoIdentity = parseGithubRepo(repo, options?.branch);

  const fetcher = new OctokitFetcher(githubToken);
  const maxFiles = options?.maxFiles && Number.isFinite(options.maxFiles)
    ? Math.max(1, Math.floor(options.maxFiles))
    : DEFAULT_MAX_FILES;
  const maxFileSizeBytes = ((options?.maxFileSizeKb && Number.isFinite(options.maxFileSizeKb))
    ? Math.max(1, Math.floor(options.maxFileSizeKb))
    : DEFAULT_MAX_FILE_SIZE_KB) * 1024;

  const resourceId = repoIdentity.resourceId;
  const resourceName = repoIdentity.slug;

  const emitLog = (message: string, level: 'info' | 'error' = 'info') => {
    if (typeof onLog === 'function') {
      onLog(message, level);
    }
  };

  const reportProgress = (current: number, total: number) => {
    if (typeof onProgress === 'function') {
      onProgress(current, total);
    }
  };

  const existingResource = await getResource(index, resourceId, normalizedNamespace);
  if (existingResource) {
    try {
      await deleteResourceFromPinecone(index, resourceId, normalizedNamespace);
      await deleteResource(index, resourceId, normalizedNamespace);
      emitLog(`Removed previous repository data for ${repoIdentity.slug}`);
    } catch (cleanupError) {
      if (process.env.DOC_INDEX_DEBUG === '1') {
        console.warn('Failed to remove existing repository resource:', cleanupError);
      }
      emitLog(`Failed to remove previous repository data for ${repoIdentity.slug}`, 'error');
    }
  }

  const resource: Resource = {
    id: resourceId,
    name: resourceName,
    type: 'repo',
    status: 'indexing',
    chunksProcessed: 0,
    totalChunks: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repo: repoIdentity.slug,
    branch: repoIdentity.branch,
    fileCount: 0,
    snippetCount: 0,
    enrichedCount: 0,
  };

  await addResource(index, resource, normalizedNamespace);
  emitLog(`Started indexing repository ${repoIdentity.slug}@${repoIdentity.branch}`);

  const tree = await fetcher.fetchRepoTree(repoIdentity.owner, repoIdentity.name, repoIdentity.branch);
  if (!Array.isArray(tree) || tree.length === 0) {
    emitLog(`Repository tree empty for ${repoIdentity.slug}@${repoIdentity.branch}`, 'error');
    await updateResource(index, resourceId, {
      status: 'error',
      error: 'Repository tree is empty or inaccessible',
      updatedAt: Date.now(),
    }, normalizedNamespace);
    throw new Error(`Repository ${repoIdentity.slug} does not contain any indexable files.`);
  }

  const selectedFiles: RepoFile[] = [];
  for (const file of tree) {
    if (shouldSkipPath(file.path)) continue;
    if (file.size > maxFileSizeBytes) continue;
    if (!filterByLanguage(file.path, options?.languages)) continue;
    if (!detectLanguage(file.path)) continue;
    selectedFiles.push(file);
    if (selectedFiles.length >= maxFiles) break;
  }

  resource.totalChunks = selectedFiles.length;
  resource.fileCount = selectedFiles.length;
  await updateResource(index, resourceId, {
    totalChunks: resource.totalChunks,
    fileCount: resource.fileCount,
    updatedAt: Date.now(),
  }, normalizedNamespace);
  reportProgress(0, resource.totalChunks);
  emitLog(`Selected ${resource.totalChunks} files for indexing`);

  const fileDescriptors: FileDescriptor[] = [];
  const snippetDescriptors: SnippetDescriptor[] = [];
  let skippedFiles = 0;
  let metadataEnriched = 0;
  const shouldEnrich = Boolean(options?.enrichMetadata);

  for (const file of selectedFiles) {
    const content = await fetcher.fetchFileContent(repoIdentity.owner, repoIdentity.name, file.path);
    if (!content) {
      skippedFiles += 1;
      continue;
    }

    const language = detectLanguage(file.path);
    if (!language) {
      skippedFiles += 1;
      continue;
    }

    const snippets = extractSnippets(content, language);
    const importsList = extractImportModules(content);
    const exportsList = extractExportSymbols(content);
    const docstring = extractDocstring(content);
    const fileSummary = summarizeContent(content);

    let semanticMetadata: SemanticFileMetadata | undefined;
    if (shouldEnrich && content.split('\n').length >= 3) {
      const metadataInput: SemanticMetadataInput = {
        path: file.path,
        language,
        functions: snippets.map(snippet => snippet.name),
        imports: importsList,
        exports: exportsList,
        docstring,
        fileSummary,
      };
      const enriched = await generateSemanticFileMetadata(openaiKey, metadataInput);
      if (enriched) {
        semanticMetadata = enriched;
        metadataEnriched += 1;
      }
    }

    const fileDescriptor = buildFileDescriptor(
      repoIdentity,
      file.path,
      language,
      snippets,
      {
        imports: importsList,
        exports: exportsList,
        docstring,
        semantic: semanticMetadata,
      }
    );
    fileDescriptors.push(fileDescriptor);
    snippetDescriptors.push(
      ...buildSnippetDescriptors(repoIdentity, file.path, language, snippets, semanticMetadata)
    );

    resource.chunksProcessed += 1;
    resource.enrichedCount = metadataEnriched;
    await updateResource(index, resourceId, {
      chunksProcessed: resource.chunksProcessed,
      enrichedCount: metadataEnriched,
      updatedAt: Date.now(),
    }, normalizedNamespace);
    reportProgress(resource.chunksProcessed, resource.totalChunks);
    emitLog(`Indexed ${file.path}${snippets.length > 0 ? ` (${snippets.length} snippets)` : ''}`);
  }

  const fileEmbeddings = fileDescriptors.length > 0
    ? await generateEmbeddings(openaiKey, fileDescriptors.map(d => d.text))
    : [];
  const snippetEmbeddings = snippetDescriptors.length > 0
    ? await generateEmbeddings(openaiKey, snippetDescriptors.map(d => d.text))
    : [];

  const vectors: VectorRecord[] = [];
  const timestamp = Date.now();

  fileDescriptors.forEach((descriptor, indexPosition) => {
    const embedding = fileEmbeddings[indexPosition];
    if (!embedding) return;
    const metadata: any = {
      type: 'repo',
      granularity: 'file',
      resourceId,
      resourceName,
      content: descriptor.text,
      url: descriptor.url,
      indexed: timestamp,
      repo: repoIdentity.slug,
      branch: repoIdentity.branch,
      path: descriptor.path,
      language: descriptor.language,
      functions: descriptor.functions,
      exports: descriptor.exports,
      imports: descriptor.imports,
    };
    if (descriptor.semantic) {
      try {
        metadata.semanticJson = JSON.stringify(descriptor.semantic);
      } catch {
        metadata.semanticJson = undefined;
      }
      metadata.primaryPurpose = descriptor.semantic.primaryPurpose;
      metadata.architectureRole = descriptor.semantic.architectureRole;
      metadata.dependsOn = descriptor.semantic.dependsOn;
      metadata.interactionType = descriptor.semantic.interactionType;
      metadata.complexity = descriptor.semantic.complexity;
      metadata.keyEntities = descriptor.semantic.keyEntities;
    }
    vectors.push({
      id: descriptor.id,
      values: embedding,
      metadata,
    });
  });

  snippetDescriptors.forEach((descriptor, indexPosition) => {
    const embedding = snippetEmbeddings[indexPosition];
    if (!embedding) return;
    const metadata: any = {
      type: 'repo',
      granularity: descriptor.granularity,
      resourceId,
      resourceName,
      content: descriptor.text,
      url: descriptor.url,
      indexed: timestamp,
      repo: repoIdentity.slug,
      branch: repoIdentity.branch,
      path: descriptor.path,
      language: descriptor.language,
      symbol: descriptor.symbol,
    };
    if (descriptor.semantic) {
      try {
        metadata.semanticJson = JSON.stringify(descriptor.semantic);
      } catch {
        metadata.semanticJson = undefined;
      }
      metadata.primaryPurpose = descriptor.semantic.primaryPurpose;
      metadata.architectureRole = descriptor.semantic.architectureRole;
      metadata.dependsOn = descriptor.semantic.dependsOn;
      metadata.interactionType = descriptor.semantic.interactionType;
      metadata.complexity = descriptor.semantic.complexity;
      metadata.keyEntities = descriptor.semantic.keyEntities;
    }
    vectors.push({
      id: descriptor.id,
      values: embedding,
      metadata,
    });
  });

  if (vectors.length === 0) {
    await updateResource(index, resourceId, {
      status: 'error',
      error: 'No vectors generated for repository',
      updatedAt: Date.now(),
    }, normalizedNamespace);
    throw new Error(`Repository ${repoIdentity.slug} did not produce any embeddings.`);
  }

  await upsertVectors(index, vectors, normalizedNamespace);

  await updateResource(index, resourceId, {
    status: 'ready',
    updatedAt: Date.now(),
    snippetCount: snippetDescriptors.length,
    enrichedCount: metadataEnriched,
  }, normalizedNamespace);
  reportProgress(resource.chunksProcessed, resource.totalChunks);
  emitLog(`Completed indexing for ${repoIdentity.slug}@${repoIdentity.branch}`);

  return {
    repo: repoIdentity.slug,
    branch: repoIdentity.branch,
    namespace: normalizedNamespace,
    filesIndexed: fileDescriptors.length,
    snippetsIndexed: snippetDescriptors.length,
    skippedFiles,
    resourceId,
    metadataEnriched,
  };
}
