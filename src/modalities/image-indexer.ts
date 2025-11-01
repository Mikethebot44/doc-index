import { createHash } from 'crypto';
import type { Buffer } from 'node:buffer';
import { ClipImageEncoder } from '../encoders/image';
import { upsertVectors } from '../pinecone';
import {
  addResource,
  updateResource,
  deleteResource,
  deleteResourceFromPinecone,
  getResource,
} from '../resource-manager';
import type { IndexSourceInput, VectorRecord, VectorMetadata } from '../types';
import { loadSource } from '../utils/source-loader';

export interface IndexImageSourceParams extends IndexSourceInput {
  openaiKey: string;
  textIndex: any;
  imageIndex: any;
  namespace: string;
  onProgress?: (current: number, total: number) => void;
  onLog?: (message: string, level?: 'info' | 'error') => void;
}

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
      return `image:${slug}`;
    }
  }

  const fallbackSlug = slugify(filename);
  if (fallbackSlug) {
    return `image:${fallbackSlug}`;
  }

  const digest = createHash('sha256').update(data).digest('hex').slice(0, 24);
  return `image:${digest}`;
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

export async function indexImageSource(params: IndexImageSourceParams): Promise<string> {
  const { source, textIndex, imageIndex, namespace, openaiKey, onProgress, onLog, metadata } = params;
  const loaded = await loadSource(source, { mimeType: params.mimeType, filename: params.name });

  if (loaded.modality !== 'image') {
    throw new Error('Provided source is not detected as image. Only image indexing is supported for this pipeline.');
  }

  const resourceId = deriveResourceId(params.id, loaded.source, loaded.filename, loaded.data);
  const resourceName = params.name ?? loaded.filename;
  const encoder = new ClipImageEncoder(openaiKey);
  const now = Date.now();

  emitLog(onLog, `Preparing to index image resource ${resourceName}`);

  const existingResource = await getResource(textIndex, resourceId, namespace);
  if (existingResource) {
    emitLog(onLog, `Existing resource found for ${resourceId}, replacing previous vectors.`);
    await deleteResourceFromPinecone(textIndex, resourceId, namespace);
    await deleteResourceFromPinecone(imageIndex, resourceId, namespace);
    await deleteResource(textIndex, resourceId, namespace);
  }

  await addResource(textIndex, {
    id: resourceId,
    name: resourceName,
    type: 'doc',
    status: 'indexing',
    chunksProcessed: 0,
    totalChunks: 0,
    createdAt: now,
    updatedAt: now,
    modality: 'image',
    mediaUrl: loaded.source,
    mediaType: loaded.mimeType,
  }, namespace);

  try {
    emitLog(onLog, `Generating CLIP embedding for image ${resourceName}`);
    const clipVector = await encoder.embed({
      data: loaded.data,
      mimeType: loaded.mimeType,
      source: loaded.source,
    });

    const baseContent =
      metadata?.content ??
      params.description ??
      resourceName ??
      'Image asset';

    const metadataOverrides: Partial<VectorMetadata> = { ...(metadata ?? {}) };
    delete metadataOverrides.resourceId;
    delete metadataOverrides.resourceName;
    delete metadataOverrides.level;
    delete metadataOverrides.indexed;
    delete metadataOverrides.modality;
    delete metadataOverrides.contentType;

    const vectorMetadata: VectorMetadata = {
      type: 'doc',
      resourceId,
      resourceName,
      content: baseContent,
      url: metadata?.url ?? loaded.source,
      mediaUrl: loaded.source,
      mediaType: loaded.mimeType,
      level: 'chunk',
      indexed: Date.now(),
      modality: 'image',
      contentType: 'image',
      wordCount: undefined,
      ...metadataOverrides,
    };

    const vectors: VectorRecord[] = [
      {
        id: `${resourceId}::image`,
        values: clipVector,
        metadata: vectorMetadata,
      },
    ];

    await upsertVectors(imageIndex, vectors, namespace);

    await updateResource(textIndex, resourceId, {
      status: 'ready',
      chunksProcessed: 1,
      totalChunks: 1,
      modality: 'image',
      mediaUrl: loaded.source,
      mediaType: loaded.mimeType,
    }, namespace);

    if (typeof onProgress === 'function') {
      onProgress(1, 1);
    }
    emitLog(onLog, `Image resource ${resourceName} indexed successfully.`);
    return resourceId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLog(onLog, `Failed to index image resource: ${message}`, 'error');
    await updateResource(textIndex, resourceId, {
      status: 'error',
      error: message,
      modality: 'image',
      mediaUrl: loaded.source,
      mediaType: loaded.mimeType,
    }, namespace);
    throw error;
  }
}
