import { promises as fs } from 'fs';
import { basename, extname, isAbsolute, resolve } from 'path';
import { randomUUID } from 'crypto';
import { Buffer } from 'buffer';
import type { Modality } from '../types';
import { detectModality } from './modality';

export interface LoadSourceOptions {
  mimeType?: string;
  filename?: string;
}

export interface LoadedSource {
  data: Buffer;
  mimeType?: string;
  filename: string;
  source?: string;
  modality: Modality;
}

function isRemoteSource(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveLocalPath(value: string): string {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(process.cwd(), value);
}

async function loadRemoteSource(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function loadLocalSource(path: string): Promise<Buffer> {
  const resolved = resolveLocalPath(path);
  return await fs.readFile(resolved);
}

function inferFilename(source?: string, overrideName?: string): string {
  if (overrideName && overrideName.trim().length > 0) {
    return overrideName.trim();
  }
  if (!source) {
    return `media-${randomUUID()}`;
  }
  try {
    if (isRemoteSource(source)) {
      const url = new URL(source);
      const candidate = basename(url.pathname);
      if (candidate) return candidate;
    }
  } catch {
    // ignore URL parse errors and fall back below
  }
  const base = basename(source);
  if (base) {
    return base;
  }
  return `media-${randomUUID()}`;
}

function normalizeMimeType(mimeType?: string): string | undefined {
  return mimeType?.toLowerCase().trim() || undefined;
}

export async function loadSource(
  source: string | Buffer,
  options: LoadSourceOptions = {}
): Promise<LoadedSource> {
  let data: Buffer;
  let sourceHint: string | undefined;

  if (typeof source === 'string') {
    sourceHint = source;
    data = isRemoteSource(source) ? await loadRemoteSource(source) : await loadLocalSource(source);
  } else {
    data = Buffer.isBuffer(source) ? source : Buffer.from(source);
  }

  const filename = inferFilename(sourceHint, options.filename);
  const explicitMime = normalizeMimeType(options.mimeType);
  const { modality, mimeType: detectedMime } = detectModality(
    sourceHint ?? filename,
    {
      mimeType: explicitMime,
      filename,
    }
  );

  let mimeType = explicitMime ?? detectedMime;
  if (!mimeType) {
    const extension = extname(filename).toLowerCase();
    if (extension === '.mp3') mimeType = 'audio/mpeg';
    else if (extension === '.wav') mimeType = 'audio/wav';
    else if (extension === '.m4a') mimeType = 'audio/mp4';
    else if (extension === '.flac') mimeType = 'audio/flac';
    else if (extension === '.ogg' || extension === '.oga') mimeType = 'audio/ogg';
  }

  return {
    data,
    mimeType,
    filename,
    source: sourceHint,
    modality,
  };
}
