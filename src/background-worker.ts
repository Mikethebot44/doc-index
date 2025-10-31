import { DocIndexSDK } from './index';
import { getJob, updateJob, appendJobLog } from './job-store';
import { DocIndexConfig, IndexJobProgress, IndexRepositoryOptions, IndexDocumentationOptions } from './types';

function formatWorkerError(error: unknown): string {
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

async function run(): Promise<void> {
  const jobId = process.env.DOC_INDEX_JOB_ID;
  const configJson = process.env.DOC_INDEX_CONFIG;

  if (!jobId) {
    console.error('DOC_INDEX_JOB_ID was not provided.');
    return;
  }

  const job = await getJob(jobId);
  if (!job) {
    console.error(`Background job not found: ${jobId}`);
    return;
  }

  if (!configJson) {
    await updateJob(jobId, {
      status: 'failed',
      error: 'Missing DOC_INDEX_CONFIG payload',
    });
    console.error('DOC_INDEX_CONFIG was not provided.');
    return;
  }

  let config: DocIndexConfig | undefined;
  try {
    config = JSON.parse(configJson) as DocIndexConfig;
  } catch (error) {
    await updateJob(jobId, {
      status: 'failed',
      error: `Failed to parse DOC_INDEX_CONFIG: ${formatWorkerError(error)}`,
    });
    console.error('Invalid DOC_INDEX_CONFIG JSON.');
    return;
  }

  if (!config?.openaiKey || !config?.pineconeKey) {
    await updateJob(jobId, {
      status: 'failed',
      error: 'Incomplete job configuration',
    });
    console.error('DOC_INDEX_CONFIG missing required OpenAI or Pinecone keys.');
    return;
  }

  await updateJob(jobId, {
    status: 'in-progress',
    startedAt: Date.now(),
    error: undefined,
  });
  const jobLabel = job.type === 'repo'
    ? job.repo ?? job.url ?? 'repository'
    : job.url ?? 'documentation task';
  await appendJobLog(jobId, `Background worker started for ${jobLabel}`);

  const sdk = new DocIndexSDK(config);
  let lastProgress: IndexJobProgress = job.progress;

  try {
    const handleProgress = (current: number, total: number) => {
      lastProgress = { current, total };
      void updateJob(jobId, {
        progress: lastProgress,
        updatedAt: Date.now(),
      });
    };

    const handleLog = (message: string, level: 'info' | 'error' = 'info') => {
      if (level === 'error') {
        console.error(`[${jobId}] ${message}`);
      } else {
        console.log(`[${jobId}] ${message}`);
      }
      void appendJobLog(jobId, message, level);
    };

    if (job.type === 'repo') {
      const repoTarget = job.url ?? job.repo;
      if (!repoTarget) {
        throw new Error('Repository target was not provided for background job');
      }
      const repoOptions = (job.options ?? {}) as IndexRepositoryOptions;
      const result = await sdk.indexRepo(
        repoTarget,
        repoOptions,
        handleProgress,
        handleLog
      );
      lastProgress = {
        current: result.filesIndexed,
        total: result.filesIndexed,
      };
      await appendJobLog(jobId, `Background repository indexing completed for ${result.repo}@${result.branch}`);
      await updateJob(jobId, {
        status: 'completed',
        completedAt: Date.now(),
        resourceId: result.resourceId,
        progress: lastProgress,
        error: undefined,
        repo: result.repo,
      });
    } else {
      const docTarget = job.url;
      if (!docTarget) {
        throw new Error('URL target was not provided for documentation job');
      }
      const docOptions = (job.options ?? {}) as IndexDocumentationOptions;
      const resourceId = await sdk.indexDocumentation(
        docTarget,
        docOptions,
        handleProgress,
        handleLog
      );

      await appendJobLog(jobId, `Background indexing completed for ${docTarget}`);
      await updateJob(jobId, {
        status: 'completed',
        completedAt: Date.now(),
        resourceId,
        progress: lastProgress,
        error: undefined,
      });
    }
  } catch (error) {
    const message = formatWorkerError(error);
    await appendJobLog(jobId, `Background indexing failed: ${message}`, 'error');
    await updateJob(jobId, {
      status: 'failed',
      error: message,
      progress: lastProgress,
    });
    console.error(`Background indexing failed for job ${jobId}:`, error);
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error('Background worker encountered an unexpected error:', error);
  process.exitCode = 1;
});
