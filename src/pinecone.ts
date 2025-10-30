import { Pinecone } from '@pinecone-database/pinecone';
import { VectorMetadata, VectorRecord } from './types';
import { retry } from './utils/retry';
import { handleError } from './utils/error';

let pineconeClient: Pinecone | null = null;

export function getPineconeClient(pineconeKey: string): Pinecone {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: pineconeKey });
  }
  return pineconeClient;
}

export function normalizeNamespace(namespace?: string): string {
  const trimmed = typeof namespace === 'string' ? namespace.trim() : '';
  return trimmed.length > 0 ? trimmed : '__default__';
}

export async function getOrCreateIndex(
  pineconeKey: string,
  indexName: string,
  dimensions: number
): Promise<any> {
  try {
    const pinecone = getPineconeClient(pineconeKey);
    
    const indexes = await pinecone.listIndexes();
    const indexExists = indexes.indexes?.some(idx => idx.name === indexName);
    
    if (!indexExists) {
      await pinecone.createIndex({
        name: indexName,
        dimension: dimensions,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
      });
    }
    
    return pinecone.index(indexName);
  } catch (error) {
    handleError(error, 'Failed to get or create Pinecone index');
  }
}

export async function upsertVectors(
  index: any,
  vectors: VectorRecord[],
  namespace?: string
): Promise<void> {
  try {
    const BATCH_SIZE = 100;
    const normalizedNamespace = normalizeNamespace(namespace);

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);

      await retry(
        async () => {
          const payload = batch.map(v => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata,
          }));

          const namespaced = typeof index.namespace === 'function'
            ? index.namespace(normalizedNamespace)
            : undefined;

          if (namespaced && typeof namespaced.upsert === 'function') {
            await namespaced.upsert(payload);
            return;
          }

          if (typeof index.upsert !== 'function') {
            throw new Error('Pinecone index does not support upsert operations');
          }

          try {
            await index.upsert({
              namespace: normalizedNamespace,
              vectors: payload,
            });
          } catch (error) {
            try {
              await index.upsert(payload, normalizedNamespace);
            } catch {
              throw error;
            }
          }
        }
      );
    }
  } catch (error) {
    handleError(error, 'Failed to upsert vectors');
  }
}

export async function deleteVectorsByFilter(
  index: any,
  filter: Record<string, any>,
  namespace?: string
): Promise<void> {
  try {
    const normalizedNamespace = normalizeNamespace(namespace);
    await retry(
      async () => {
        const namespaced = typeof index.namespace === 'function'
          ? index.namespace(normalizedNamespace)
          : undefined;

        if (namespaced && typeof namespaced.deleteMany === 'function') {
          await namespaced.deleteMany(filter);
          return;
        }

        if (typeof index.deleteMany !== 'function') {
          throw new Error('Pinecone index does not support deleteMany operations');
        }

        try {
          await index.deleteMany({
            namespace: normalizedNamespace,
            filter,
          });
        } catch (error) {
          try {
            await index.deleteMany(filter, normalizedNamespace);
          } catch {
            throw error;
          }
        }
      }
    );
  } catch (error) {
    handleError(error, 'Failed to delete vectors');
  }
}

export async function queryVectors(
  index: any,
  queryVector: number[],
  topK: number,
  filter?: Record<string, any>,
  namespace?: string
): Promise<any[]> {
  try {
    const normalizedNamespace = normalizeNamespace(namespace);
    const namespaced = typeof index.namespace === 'function'
      ? index.namespace(normalizedNamespace)
      : undefined;

    const result = await retry(
      async () => {
        if (namespaced && typeof namespaced.query === 'function') {
          return await namespaced.query({
            vector: queryVector,
            topK,
            includeMetadata: true,
            filter,
          });
        }

        if (typeof index.query !== 'function') {
          throw new Error('Pinecone index does not support query operations');
        }

        try {
          return await index.query({
            vector: queryVector,
            topK,
            includeMetadata: true,
            filter,
            namespace: normalizedNamespace,
          });
        } catch (error) {
          return await index.query({
            vector: queryVector,
            topK,
            includeMetadata: true,
            filter,
          }, normalizedNamespace);
        }
      }
    );

    return result.matches || [];
  } catch (error) {
    handleError(error, 'Failed to query vectors');
  }
}

