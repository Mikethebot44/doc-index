import { createHash } from 'crypto';
import type { Buffer } from 'node:buffer';
import { WhisperAudioEncoder } from '../encoders/audio';
import { generateEmbeddings, splitTextToTokenLimit } from '../openai';
import { upsertVectors } from '../pinecone';
import {
  addResource,
  updateResource,
  deleteResource,
  deleteResourceFromPinecone,
  getResource,
} from '../resource-manager';
import type { IndexSourceInput, VectorMetadata, VectorRecord } from '../types';
import { loadSource } from '../utils/source-loader';
import type { AudioTranscriptionResult } from '../transcription';

export interface IndexAudioSourceParams extends IndexSourceInput {
  openaiKey: string;
  index: any;
  namespace: string;
  onProgress?: (current: number, total: number) => void;
  onLog?: (message: string, level?: 'info' | 'error') => void;
}

const DEFAULT_AUDIO_CHUNK_TOKEN_LIMIT = 2000;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function deriveResourceId(
  providedId: string | undefined,
  sourceHint: string | undefined,
  filename: string,
  data: Buffer
): string {
  if (providedId && providedId.trim().length > 0) {
    return providedId.trim();
  }

  if (sourceHint && sourceHint.trim().length > 0) {
    const slug = slugify(sourceHint);
    if (slug) {
      return `audio:${slug}`;
    }
  }

  const fallbackSlug = slugify(filename);
  if (fallbackSlug) {
    return `audio:${fallbackSlug}`;
  }

  const digest = createHash('sha256').update(data).digest('hex').slice(0, 24);
  return `audio:${digest}`;
}

function emitLog(
  log: ((message: string, level?: 'info' | 'error') => void) | undefined,
  message: string,
  level: 'info' | 'error' = 'info'
) {
  if (typeof log === 'function') {
    log(message, level);
  }
}

export async function indexAudioSource(params: IndexAudioSourceParams): Promise<string> {
  const { source, index, namespace, openaiKey, onProgress, onLog, metadata } = params;
  const loaded = await loadSource(source, { mimeType: params.mimeType, filename: params.name });

  if (loaded.modality !== 'audio') {
    throw new Error('Provided source is not detected as audio. Only audio indexing is supported.');
  }

  const resourceId = deriveResourceId(params.id, loaded.source, loaded.filename, loaded.data);
  const resourceName = params.name ?? loaded.filename;

  emitLog(onLog, `Preparing to index audio resource ${resourceName}`);

  const existingResource = await getResource(index, resourceId, namespace);
  if (existingResource) {
    emitLog(onLog, `Existing resource found for ${resourceId}, replacing previous vectors.`);
    await deleteResourceFromPinecone(index, resourceId, namespace);
    await deleteResource(index, resourceId, namespace);
  }

  const now = Date.now();
  await addResource(index, {
    id: resourceId,
    name: resourceName,
    type: 'doc',
    status: 'indexing',
    chunksProcessed: 0,
    totalChunks: 0,
    createdAt: now,
    updatedAt: now,
    modality: 'audio',
  }, namespace);

  const encoder = new WhisperAudioEncoder(openaiKey);

  let transcriptResult: AudioTranscriptionResult | undefined;
  try {
    emitLog(onLog, `Transcribing audio (${resourceName}) using Whisper.`);
    transcriptResult = await encoder.transcribe({
      data: loaded.data,
      mimeType: loaded.mimeType,
      filename: loaded.filename,
    });
    if (!transcriptResult) {
      throw new Error('Whisper transcription returned no result.');
    }

    const transcript = transcriptResult.text.trim();
    const durationSeconds = transcriptResult.durationSeconds;

    if (!transcript) {
      throw new Error('No transcript returned from Whisper.');
    }

    emitLog(onLog, `Transcript generated (${transcript.length} characters). Chunking for embedding.`);
    const chunks = await splitTextToTokenLimit(openaiKey, transcript, DEFAULT_AUDIO_CHUNK_TOKEN_LIMIT);
    const chunkCount = chunks.length;
    const embeddings = await generateEmbeddings(openaiKey, chunks);

    const metadataOverrides: Partial<VectorMetadata> = { ...(metadata ?? {}) };
    delete metadataOverrides.content;
    delete metadataOverrides.resourceId;
    delete metadataOverrides.resourceName;
    delete metadataOverrides.level;
    delete metadataOverrides.indexed;
    delete metadataOverrides.modality;
    delete metadataOverrides.contentType;
    if (durationSeconds !== undefined) {
      metadataOverrides.durationSeconds = durationSeconds;
    }

    const vectors: VectorRecord[] = embeddings.map((values, indexPosition) => {
      const content = chunks[indexPosition];
      const vectorMetadata: VectorMetadata = {
        type: 'doc',
        resourceId,
        resourceName,
        content,
        url: loaded.source,
        level: 'chunk',
        indexed: Date.now(),
        modality: 'audio',
        contentType: 'audio-transcript',
        wordCount: content.split(/\s+/).filter(Boolean).length,
        durationSeconds,
        ...metadataOverrides,
      };
      return {
        id: `${resourceId}::${String(indexPosition + 1).padStart(4, '0')}`,
        values,
        metadata: vectorMetadata,
      };
    });

    emitLog(onLog, `Upserting ${vectors.length} audio transcript vectors to Pinecone.`);
    await upsertVectors(index, vectors, namespace);

    await updateResource(index, resourceId, {
      status: 'ready',
      chunksProcessed: chunkCount,
      totalChunks: chunkCount,
      modality: 'audio',
      durationSeconds,
    }, namespace);
    emitLog(onLog, `Audio resource ${resourceName} indexed successfully.`);
    if (typeof onProgress === 'function') {
      onProgress(chunkCount, chunkCount);
    }
    return resourceId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog(onLog, `Failed to index audio resource: ${message}`, 'error');
    await updateResource(index, resourceId, {
      status: 'error',
      error: message,
      modality: 'audio',
      durationSeconds: transcriptResult?.durationSeconds,
    }, namespace);
    throw error;
  }
}
