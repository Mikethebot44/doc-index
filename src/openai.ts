import OpenAI from 'openai';
import { retry, isRateLimitError } from './utils/retry';
import { handleError } from './utils/error';

const BATCH_SIZE = 2048;
const OPENAI_MODEL = 'text-embedding-3-large';
const OPENAI_DIMENSIONS = 3072;
const TOKENIZER_MODEL = 'gpt-4o-mini';

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

export async function countTokens(
  openaiKey: string,
  text: string
): Promise<number> {
  const openai = new OpenAI({ apiKey: openaiKey });
  try {
    const resp = await retry(
      async () =>
        await openai.chat.completions.create({
          model: TOKENIZER_MODEL,
          messages: [{ role: 'user', content: text }],
          max_tokens: 1,
          temperature: 0,
        }),
      isRateLimitError
    );
    return (resp as any).usage?.prompt_tokens ?? 0;
  } catch {
    // Fallback: rough estimate ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

export async function splitTextToTokenLimit(
  openaiKey: string,
  text: string,
  maxTokens: number
): Promise<string[]> {
  const tokens = await countTokens(openaiKey, text);
  if (tokens <= maxTokens) return [text];

  // Split by paragraph or newline near the middle
  const midpoint = Math.floor(text.length / 2);
  const leftBreak = text.lastIndexOf('\n\n', midpoint);
  const rightBreak = text.indexOf('\n\n', midpoint + 1);
  let splitPoint = midpoint;
  if (leftBreak !== -1 && midpoint - leftBreak < 1000) splitPoint = leftBreak + 2;
  else if (rightBreak !== -1 && rightBreak - midpoint < 1000) splitPoint = rightBreak + 2;

  const a = text.slice(0, splitPoint).trim();
  const b = text.slice(splitPoint).trim();
  const parts: string[] = [];
  if (a.length > 0) parts.push(...(await splitTextToTokenLimit(openaiKey, a, maxTokens)));
  if (b.length > 0) parts.push(...(await splitTextToTokenLimit(openaiKey, b, maxTokens)));
  return parts;
}

