import type { Buffer } from 'node:buffer';
import { generateEmbedding } from '../openai';
import type { Modality } from '../types';
import { transcribeAudio } from '../transcription';
import type { AudioTranscriptionResult } from '../transcription';

export interface AudioEncoderInput {
  data: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface EncoderOutput {
  vector: number[];
  text: string;
  modality: Modality;
  durationSeconds?: number;
}

export class WhisperAudioEncoder {
  readonly modality: Modality = 'audio';

  constructor(private readonly openaiKey: string) {}

  async transcribe(input: AudioEncoderInput): Promise<AudioTranscriptionResult> {
    if (!input?.data || input.data.length === 0) {
      throw new Error('Audio input is empty; cannot transcribe.');
    }

    return await transcribeAudio(this.openaiKey, input.data, {
      mimeType: input.mimeType,
      filename: input.filename,
    });
  }

  async embed(input: AudioEncoderInput): Promise<EncoderOutput> {
    const result = await this.transcribe(input);
    const transcript = result.text.trim();
    if (!transcript) {
      return { vector: [], text: '', modality: this.modality };
    }

    const vector = await generateEmbedding(this.openaiKey, transcript);
    return {
      vector,
      text: transcript,
      modality: this.modality,
      durationSeconds: result.durationSeconds,
    };
  }

  async embedTranscript(transcript: string): Promise<number[]> {
    return await generateEmbedding(this.openaiKey, transcript);
  }
}
