import { Octokit } from '@octokit/rest';
import { chunkCode, detectLanguage } from './chunking';
import { generateEmbeddings } from './openai';
import { upsertVectors, getOrCreateIndex } from './pinecone';
import { retry } from './utils/retry';
import { addResource, updateResource } from './resource-manager';
import { VectorRecord, Resource, IndexRepositoryOptions } from './types';
import { getEmbeddingDimensions } from './openai';

export async function indexRepository(
  openaiKey: string,
  pineconeKey: string,
  githubToken: string | undefined,
  indexName: string,
  repoUrl: string,
  options: IndexRepositoryOptions = {},
  progressCallback?: (progress: { current: number; total: number }) => void
): Promise<string> {
  const octokit = githubToken ? new Octokit({ auth: githubToken }) : new Octokit();
  
  const [owner, repo] = parseRepoUrl(repoUrl);
  const branch = options.branch || 'main';
  const resourceId = `repo:${owner}/${repo}:${branch}`;
  
  const index = await getOrCreateIndex(
    pineconeKey,
    indexName,
    getEmbeddingDimensions()
  );
  
  const resource: Resource = {
    id: resourceId,
    name: `${owner}/${repo}`,
    type: 'code',
    status: 'indexing',
    chunksProcessed: 0,
    totalChunks: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  await addResource(index, resource);
  
  try {
    const files = await fetchRepositoryFiles(octokit, owner, repo, branch, options);
    
    resource.totalChunks = files.length;
    await updateResource(index, resourceId, { totalChunks: files.length });
    
    let chunksProcessed = 0;
    
    for (const file of files) {
      try {
        const content = await fetchFileContent(octokit, owner, repo, file.path, branch);
        const language = detectLanguage(file.path);
        const codeChunks = chunkCode(content, language);
        
        const embeddings = await generateEmbeddings(
          openaiKey,
          codeChunks.map(chunk => chunk.text)
        );
        
        const vectors: VectorRecord[] = codeChunks.map((chunk, i) => ({
          id: `${resourceId}:${file.path}:${i}`,
          values: embeddings[i],
          metadata: {
            type: 'code',
            resourceId,
            resourceName: `${owner}/${repo}`,
            filePath: file.path,
            content: chunk.text,
            startLine: chunk.metadata?.startLine,
            endLine: chunk.metadata?.endLine,
            language,
            indexed: Date.now(),
          },
        }));
        
        await upsertVectors(index, vectors);
        chunksProcessed += codeChunks.length;
        resource.chunksProcessed = chunksProcessed;
        
        if (progressCallback) {
          progressCallback({ current: chunksProcessed, total: resource.totalChunks });
        }
      } catch (error) {
        console.warn(`Failed to index file ${file.path}:`, error);
      }
    }
    
    await updateResource(index, resourceId, {
      status: 'ready',
      chunksProcessed,
      updatedAt: Date.now(),
    });
    
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

function parseRepoUrl(url: string): [string, string] {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) {
    throw new Error('Invalid GitHub repository URL');
  }
  return [match[1], match[2]];
}

async function fetchRepositoryFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  options: IndexRepositoryOptions
): Promise<Array<{ path: string; sha: string }>> {
  const includePaths = options.includePaths || [];
  const excludePaths = options.excludePaths || [
    'node_modules',
    'dist',
    'build',
    '.git',
    'coverage',
  ];
  
  const files: Array<{ path: string; sha: string }> = [];
  
  async function traverseTree(prefix: string): Promise<void> {
    const { data } = await retry(
      async () => octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: true,
      })
    );
    
    for (const item of data.tree || []) {
      if (item.type === 'blob' && item.path) {
        if (includePaths.length > 0) {
          const matches = includePaths.some(pattern =>
            item.path?.startsWith(pattern)
          );
          if (!matches) continue;
        }
        
        if (excludePaths.some(pattern => item.path?.includes(pattern))) {
          continue;
        }
        
        const ext = item.path.split('.').pop()?.toLowerCase();
        if (ext && ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'rb', 'php', 'html', 'css', 'sql'].includes(ext)) {
          files.push({ path: item.path, sha: item.sha });
        }
      }
    }
  }
  
  await traverseTree('');
  return files;
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<string> {
  const { data } = await retry(
    async () => octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    })
  );
  
  if ('content' in data && data.content) {
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    return decoded;
  }
  
  throw new Error(`Failed to get content for ${path}`);
}

