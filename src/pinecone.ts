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
      });
    }
    
    return pinecone.index(indexName);
  } catch (error) {
    handleError(error, 'Failed to get or create Pinecone index');
  }
}

export async function upsertVectors(
  index: any,
  vectors: VectorRecord[]
): Promise<void> {
  try {
    const BATCH_SIZE = 100;
    
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      
      await retry(
        async () => {
          await index.upsert(batch.map(v => ({
            id: v.id,
            values: v.values,
            metadata: v.metadata,
          })));
        }
      );
    }
  } catch (error) {
    handleError(error, 'Failed to upsert vectors');
  }
}

export async function deleteVectorsByFilter(
  index: any,
  filter: Record<string, any>
): Promise<void> {
  try {
    await retry(
      async () => {
        await index.deleteMany(filter);
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
  filter?: Record<string, any>
): Promise<any[]> {
  try {
    const result = await retry(
      async () => {
        return await index.query({
          vector: queryVector,
          topK,
          includeMetadata: true,
          filter,
        });
      }
    );
    
    return result.matches || [];
  } catch (error) {
    handleError(error, 'Failed to query vectors');
  }
}

