import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { IndexJob, IndexJobLogEntry, IndexJobStatus } from './types';

const DEFAULT_DIR = path.join(os.homedir(), '.doc-index');
const JOBS_FILE_NAME = 'jobs.json';

let jobStoreLock: Promise<void> = Promise.resolve();

function resolveStorePath(): string {
  const root = process.env.DOC_INDEX_HOME && process.env.DOC_INDEX_HOME.trim().length > 0
    ? process.env.DOC_INDEX_HOME
    : DEFAULT_DIR;
  return path.join(root, JOBS_FILE_NAME);
}

async function ensureStoreDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function withJobStore<T>(operation: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const previous = jobStoreLock;
  jobStoreLock = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    const result = await operation();
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

function normalizeStatus(status: unknown): IndexJobStatus {
  if (status === 'in-progress' || status === 'completed' || status === 'failed') {
    return status;
  }
  return 'queued';
}

function parseJobsPayload(raw: string): IndexJob[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((entry: any) => {
    const rawLogs = Array.isArray(entry?.logs) ? entry.logs : [];
    const logs: IndexJobLogEntry[] = rawLogs.map((log: any) => ({
      timestamp: Number(log?.timestamp) || Date.now(),
      level: log?.level === 'error' ? 'error' : 'info',
      message: typeof log?.message === 'string' ? log.message : JSON.stringify(log?.message ?? ''),
    }));

    const progress = entry?.progress
      ? {
          current: Number(entry.progress.current) || 0,
          total: Number(entry.progress.total) || 0,
        }
      : { current: 0, total: 0 };

    const normalized: IndexJob = {
      id: typeof entry?.id === 'string' ? entry.id : `job_${Date.now().toString(36)}`,
      resourceId: typeof entry?.resourceId === 'string' ? entry.resourceId : '',
      url: typeof entry?.url === 'string' ? entry.url : '',
      options: entry?.options ?? {},
      status: normalizeStatus(entry?.status),
      progress,
      createdAt: Number(entry?.createdAt) || Date.now(),
      updatedAt: Number(entry?.updatedAt) || Date.now(),
      startedAt: entry?.startedAt ? Number(entry.startedAt) : undefined,
      completedAt: entry?.completedAt ? Number(entry.completedAt) : undefined,
      error: typeof entry?.error === 'string' ? entry.error : undefined,
      logs,
    };
    return normalized;
  });
}

function findClosingBracketIndex(raw: string): number | null {
  let inString = false;
  let escaping = false;
  let depth = 0;
  let closingIndex: number | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        closingIndex = i;
        break;
      }
    }
  }

  return closingIndex;
}

function repairJobsJson(raw: string): string | null {
  const closingIndex = findClosingBracketIndex(raw);
  if (closingIndex === null) {
    return null;
  }

  const candidate = raw.slice(0, closingIndex + 1);

  try {
    const parsed = JSON.parse(candidate);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

async function readJobs(filePath: string): Promise<IndexJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    return parseJobsPayload(raw);
  } catch (error) {
    const repaired = repairJobsJson(raw);
    if (repaired) {
      await fs.writeFile(filePath, repaired, 'utf8');
      console.warn('Detected corrupted job history. Repairs were applied automatically.');
      return parseJobsPayload(repaired);
    }
    throw error;
  }
}

async function writeJobs(filePath: string, jobs: IndexJob[]): Promise<void> {
  await ensureStoreDir(filePath);
  const payload = JSON.stringify(jobs, null, 2);
  await fs.writeFile(filePath, payload, 'utf8');
}

export async function listJobs(): Promise<IndexJob[]> {
  const filePath = resolveStorePath();
  return await withJobStore(async () => {
    return await readJobs(filePath);
  });
}

export async function getJob(jobId: string): Promise<IndexJob | undefined> {
  const filePath = resolveStorePath();
  return await withJobStore(async () => {
    const jobs = await readJobs(filePath);
    return jobs.find(job => job.id === jobId);
  });
}

export async function upsertJob(job: IndexJob): Promise<void> {
  const filePath = resolveStorePath();
  await withJobStore(async () => {
    const jobs = await readJobs(filePath);
    const index = jobs.findIndex(entry => entry.id === job.id);
    if (index >= 0) {
      jobs[index] = {
        ...job,
        logs: job.logs ?? jobs[index].logs ?? [],
      };
    } else {
      jobs.push({
        ...job,
        logs: job.logs ?? [],
      });
    }
    await writeJobs(filePath, jobs);
  });
}

export async function updateJob(jobId: string, updates: Partial<IndexJob>): Promise<IndexJob | undefined> {
  const filePath = resolveStorePath();
  return await withJobStore(async () => {
    const jobs = await readJobs(filePath);
    const index = jobs.findIndex(entry => entry.id === jobId);
    if (index === -1) {
      return undefined;
    }
    const job = jobs[index];
    const mergedLogs = updates.logs ? updates.logs : job.logs;
    const next: IndexJob = {
      ...job,
      ...updates,
      progress: updates.progress ?? job.progress,
      createdAt: job.createdAt,
      id: job.id,
      resourceId: job.resourceId,
      url: job.url,
      options: updates.options ? { ...job.options, ...updates.options } : job.options,
      updatedAt: Date.now(),
      logs: mergedLogs ?? [],
    };
    jobs[index] = next;
    await writeJobs(filePath, jobs);
    return next;
  });
}

export async function removeJob(jobId: string): Promise<void> {
  const filePath = resolveStorePath();
  await withJobStore(async () => {
    const jobs = await readJobs(filePath);
    const filtered = jobs.filter(job => job.id !== jobId);
    if (filtered.length === jobs.length) {
      return;
    }
    await writeJobs(filePath, filtered);
  });
}

const MAX_LOG_ENTRIES = 500;

export async function appendJobLog(jobId: string, message: string, level: 'info' | 'error' = 'info'): Promise<void> {
  const filePath = resolveStorePath();
  await withJobStore(async () => {
    const jobs = await readJobs(filePath);
    const index = jobs.findIndex(entry => entry.id === jobId);
    if (index === -1) {
      return;
    }
    const job = jobs[index];
    const entry: IndexJobLogEntry = {
      timestamp: Date.now(),
      level,
      message,
    };
    const logs = [...(job.logs ?? []), entry];
    const trimmed = logs.length > MAX_LOG_ENTRIES ? logs.slice(logs.length - MAX_LOG_ENTRIES) : logs;
    jobs[index] = {
      ...job,
      logs: trimmed,
      updatedAt: Date.now(),
    };
    await writeJobs(filePath, jobs);
  });
}
