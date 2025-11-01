import { createOpenAI } from '@ai-sdk/openai';
import { handleError } from './utils/error';
import { retry, isRateLimitError, isTimeoutError } from './utils/retry';

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

type TranscribeFn = (args: Record<string, unknown>) => Promise<any>;

interface LoadedTranscribeModule {
  transcribe?: TranscribeFn;
  NoTranscriptGeneratedError?: { isInstance?: (error: unknown) => boolean };
}

export interface AudioTranscriptionSegment {
  id?: number | string;
  text: string;
  startSecond?: number;
  endSecond?: number;
  speaker?: string;
}

export interface AudioTranscriptionResult {
  text: string;
  segments?: AudioTranscriptionSegment[];
  language?: string;
  durationSeconds?: number;
  warnings?: string[];
}

export interface TranscribeAudioOptions {
  filename?: string;
  mimeType?: string;
  model?: string;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
}

async function loadTranscribeModule(): Promise<LoadedTranscribeModule> {
  try {
    const mod: any = await import('ai');
    return {
      transcribe: mod.experimental_transcribe ?? mod.transcribe,
      NoTranscriptGeneratedError: mod.NoTranscriptGeneratedError,
    };
  } catch {
    return {};
  }
}

function toUint8Array(input: Buffer | Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new Uint8Array(0);
}

function normalizeSegments(rawSegments: any): AudioTranscriptionSegment[] | undefined {
  if (!Array.isArray(rawSegments)) {
    return undefined;
  }

  return rawSegments
    .map(segment => ({
      id: segment?.id,
      text: typeof segment?.text === 'string' ? segment.text : '',
      startSecond: typeof segment?.start === 'number' ? segment.start : segment?.startSecond,
      endSecond: typeof segment?.end === 'number' ? segment.end : segment?.endSecond,
      speaker: typeof segment?.speaker === 'string' ? segment.speaker : undefined,
    }))
    .filter(segment => segment.text.length > 0);
}

function normalizeWarnings(rawWarnings: any): string[] | undefined {
  if (!Array.isArray(rawWarnings)) {
    return undefined;
  }
  return rawWarnings
    .map(warning => {
      if (typeof warning === 'string') return warning;
      if (warning && typeof warning.message === 'string') return warning.message;
      return undefined;
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalizeLanguage(value: any): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function transcribeWithExperimentalModule(
  transcribeFn: TranscribeFn,
  audio: Buffer | Uint8Array | ArrayBuffer | string,
  options: TranscribeAudioOptions,
  modelName: string,
  openaiKey: string
): Promise<AudioTranscriptionResult> {
  const audioPayload = typeof audio === 'string' ? audio : toUint8Array(audio);
  const openai = createOpenAI({ apiKey: openaiKey });
  const model = openai.transcription(modelName);
  const shouldRetry = (error: Error) => isRateLimitError(error) || isTimeoutError(error);
  const result = await retry(
    async () =>
      await transcribeFn({
        model,
        audio: audioPayload,
        providerOptions: options.providerOptions,
        headers: options.headers,
        abortSignal: options.abortSignal,
      }),
    shouldRetry
  );

  return {
    text: typeof result?.text === 'string' ? result.text : '',
    segments: normalizeSegments(result?.segments),
    language: normalizeLanguage(result?.language),
    durationSeconds: typeof result?.durationInSeconds === 'number' ? result.durationInSeconds : undefined,
    warnings: normalizeWarnings(result?.warnings),
  };
}

async function transcribeWithProvider(
  openaiKey: string,
  audio: Buffer | Uint8Array | ArrayBuffer | string,
  options: TranscribeAudioOptions,
  modelName: string
): Promise<AudioTranscriptionResult> {
  const openai = createOpenAI({ apiKey: openaiKey });
  const model = openai.transcription(modelName);
  const audioPayload = typeof audio === 'string' ? audio : toUint8Array(audio);
  const mediaType = options.mimeType ?? 'audio/mpeg';
  const shouldRetry = (error: Error) => isRateLimitError(error) || isTimeoutError(error);

  const response = await retry(
    async () =>
      await model.doGenerate({
        audio: audioPayload,
        mediaType,
        providerOptions: options.providerOptions as any,
        headers: options.headers,
        abortSignal: options.abortSignal,
      }),
    shouldRetry
  );

  return {
    text: response.text ?? '',
    segments: normalizeSegments(response.segments),
    language: normalizeLanguage(response.language),
    durationSeconds: response.durationInSeconds ?? undefined,
    warnings: normalizeWarnings(response.warnings),
  };
}

export async function transcribeAudio(
  openaiKey: string,
  audio: Buffer | Uint8Array | ArrayBuffer | string,
  options: TranscribeAudioOptions = {}
): Promise<AudioTranscriptionResult> {
  const modelName = options.model ?? DEFAULT_TRANSCRIPTION_MODEL;

  try {
    const module = await loadTranscribeModule();
    if (module.transcribe) {
      try {
        return await transcribeWithExperimentalModule(
          module.transcribe,
          audio,
          options,
          modelName,
          openaiKey
        );
      } catch (error) {
        if (module.NoTranscriptGeneratedError?.isInstance?.(error)) {
          const cause = (error as any)?.cause;
          if (cause instanceof Error) {
            handleError(cause, 'Whisper transcription failed');
          }
        }
        // Fall back to direct provider call below if experimental transcribe fails.
      }
    }

    return await transcribeWithProvider(openaiKey, audio, options, modelName);
  } catch (error) {
    handleError(error, 'Failed to transcribe audio');
  }
}
