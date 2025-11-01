import type { Buffer } from 'node:buffer';
import { generateClipEmbedding } from '../openai';
import type { Modality } from '../types';

export interface ImageEncoderInput {
  data: Buffer;
  mimeType?: string;
  source?: string;
}

export class ClipImageEncoder {
  readonly modality: Modality = 'image';

  constructor(private readonly openaiKey: string) {}

  private buildInputPayload(input: ImageEncoderInput): string {
    const isRemoteSource =
      typeof input.source === 'string' && /^https?:\/\//i.test(input.source);
    if (isRemoteSource) {
      return input.source as string;
    }

    const mimeType = input.mimeType && input.mimeType.trim().length > 0
      ? input.mimeType
      : 'image/png';
    const base64 = input.data.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  }

  async embed(input: ImageEncoderInput): Promise<number[]> {
    if (!input?.data || input.data.length === 0) {
      throw new Error('Image input is empty; cannot generate embedding.');
    }
    const payload = this.buildInputPayload(input);
    return await generateClipEmbedding(this.openaiKey, payload);
  }
}
