import { extname } from 'path';
import type { Buffer } from 'node:buffer';
import type { Modality } from '../types';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wma',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.svg',
]);

const AUDIO_MIME_PREFIX = 'audio/';
const VIDEO_MIME_PREFIX = 'video/';
const IMAGE_MIME_PREFIX = 'image/';

export interface ModalityDetectionOptions {
  mimeType?: string;
  filename?: string;
}

export interface ModalityDetectionResult {
  modality: Modality;
  mimeType?: string;
}

function normalizeMimeType(mimeType?: string): string | undefined {
  return mimeType?.toLowerCase().trim() || undefined;
}

function inferModalityFromExtension(extension?: string): Modality | undefined {
  if (!extension) return undefined;
  const lower = extension.toLowerCase();
  if (AUDIO_EXTENSIONS.has(lower)) return 'audio';
  if (VIDEO_EXTENSIONS.has(lower)) return 'video';
  if (IMAGE_EXTENSIONS.has(lower)) return 'image';
  return undefined;
}

function parseExtensionFromSource(source: string): string | undefined {
  if (!source) return undefined;
  try {
    const withoutQuery = source.split('?')[0]?.split('#')[0] ?? source;
    const pathname = withoutQuery.includes('://') ? new URL(withoutQuery).pathname : withoutQuery;
    return extname(pathname);
  } catch {
    return extname(source);
  }
}

function inferModalityFromMime(mimeType?: string): Modality | undefined {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) return undefined;
  if (normalized.startsWith(AUDIO_MIME_PREFIX)) return 'audio';
  if (normalized.startsWith(VIDEO_MIME_PREFIX)) return 'video';
  if (normalized.startsWith(IMAGE_MIME_PREFIX)) return 'image';
  return undefined;
}

export function detectModality(
  input: string | Buffer,
  options: ModalityDetectionOptions = {}
): ModalityDetectionResult {
  const byMime = inferModalityFromMime(options.mimeType);
  if (byMime) {
    return { modality: byMime, mimeType: options.mimeType };
  }

  if (typeof input === 'string') {
    const dataUriMatch = /^data:([^;,]+)[;,]/i.exec(input);
    if (dataUriMatch) {
      const mimeFromDataUri = normalizeMimeType(dataUriMatch[1]);
      const modality = inferModalityFromMime(mimeFromDataUri);
      if (modality) {
        return { modality, mimeType: mimeFromDataUri };
      }
    }

    const extension = parseExtensionFromSource(input);
    const modality = inferModalityFromExtension(extension);
    if (modality) {
      const mimeType = normalizeMimeType(options.mimeType) ?? undefined;
      return { modality, mimeType };
    }
  }

  if (options.filename) {
    const extension = extname(options.filename);
    const modality = inferModalityFromExtension(extension);
    if (modality) {
      return { modality, mimeType: options.mimeType };
    }
  }

  return { modality: 'text', mimeType: options.mimeType };
}

export function isAudioModality(modality: Modality): boolean {
  return modality === 'audio';
}

