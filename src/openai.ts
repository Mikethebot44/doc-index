import OpenAI from 'openai';
import { retry, isRateLimitError } from './utils/retry';
import { handleError } from './utils/error';

const BATCH_SIZE = 2048;
const OPENAI_MODEL = 'text-embedding-3-large';
const OPENAI_DIMENSIONS = 3072;

export async function generateEmbedding(
  openaiKey: string,
  text: string
): Promise<number[]> {
  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    
    const response = await retry(
      async () => {
        const result = await openai.embeddings.create({
          model: OPENAI_MODEL,
          input: text,
        });
        return result;
      },
      isRateLimitError
    );
    
    return response.data[0].embedding;
  } catch (error) {
    handleError(error, 'Failed to generate embedding');
  }
}

export async function generateEmbeddings(
  openaiKey: string,
  texts: string[]
): Promise<number[][]> {
  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      
      const batchEmbeddings = await retry(
        async () => {
          const response = await openai.embeddings.create({
            model: OPENAI_MODEL,
            input: batch,
          });
          return response.data.map(item => item.embedding);
        },
        isRateLimitError
      );
      
      embeddings.push(...batchEmbeddings);
    }
    
    return embeddings;
  } catch (error) {
    handleError(error, 'Failed to generate embeddings');
  }
}

export function getEmbeddingDimensions(): number {
  return OPENAI_DIMENSIONS;
}

