import { DocIndexSDK } from './index';
import { getJob, updateJob, appendJobLog } from './job-store';
import { DocIndexConfig, IndexJobProgress } from './types';

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
  await appendJobLog(jobId, `Background worker started for ${job.url}`);

  const sdk = new DocIndexSDK(config);
  let lastProgress: IndexJobProgress = job.progress;

  try {
    const resourceId = await sdk.indexDocumentation(
      job.url,
      job.options,
      (current, total) => {
        lastProgress = { current, total };
        void updateJob(jobId, {
          progress: lastProgress,
        });
      },
      (message, level = 'info') => {
        if (level === 'error') {
          console.error(`[${jobId}] ${message}`);
        } else {
          console.log(`[${jobId}] ${message}`);
        }
        void appendJobLog(jobId, message, level);
      }
    );

    await appendJobLog(jobId, `Background indexing completed for ${job.url}`);
    await updateJob(jobId, {
      status: 'completed',
      completedAt: Date.now(),
      resourceId,
      progress: lastProgress,
      error: undefined,
    });
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
