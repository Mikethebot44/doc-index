import { generateEmbeddings, countTokens } from './openai';

export interface TextChunk {
  text: string;
  metadata?: {
    sentenceCount?: number;
    header?: string;
  };
}

export interface SemanticChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
  similarityDrop?: number;
  stdMultiplier?: number;
  smoothWindow?: number;
}

interface ResolvedOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  similarityDrop: number;
  stdMultiplier: number;
  smoothWindow: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  targetTokens: 1200,
  maxTokens: 1800,
  minTokens: 400,
  similarityDrop: 0.25,
  stdMultiplier: 1,
  smoothWindow: 2,
};

export async function chunkDocumentSemantic(
  openaiKey: string,
  content: string,
  opts: SemanticChunkOptions = {}
): Promise<TextChunk[]> {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return [];
  }

  const config: ResolvedOptions = { ...DEFAULT_OPTIONS, ...opts };
  const sentences = splitIntoSentences(normalized);
  if (sentences.length <= 1) {
    return [{ text: normalized, metadata: { sentenceCount: sentences.length || 1 } }];
  }

  const embeddings = await embedSentences(openaiKey, sentences);
  const similarities = computePairwiseSimilarities(embeddings);
  const breakPoints = detectBreakPoints(similarities, sentences.length, config);
  const segments = buildSegments(sentences, breakPoints);
  const chunks = await mergeSegments(openaiKey, segments, config);

  return chunks.map(chunk => ({
    text: chunk.text,
    metadata: { sentenceCount: chunk.sentenceCount },
  }));
}

export async function chunkMarkdownSmart(
  openaiKey: string,
  content: string,
  opts: SemanticChunkOptions = {}
): Promise<TextChunk[]> {
  return chunkDocumentSemantic(openaiKey, content, opts);
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\s+\n/g, '\n').trim();
}

function splitIntoSentences(text: string): string[] {
  const segmenterCtor = (Intl as unknown as { Segmenter?: any }).Segmenter;
  if (typeof segmenterCtor === 'function') {
    const segmenter = new segmenterCtor('en', { granularity: 'sentence' });
    const sentences: string[] = [];
    for (const entry of segmenter.segment(text) as Iterable<any>) {
      const segment = String(entry?.segment ?? '').trim();
      if (segment) sentences.push(segment);
    }
    if (sentences.length > 0) return sentences;
  }

  return text
    .split(/(?<=[\.\?\!])\s+(?=[A-Z0-9"'])/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

async function embedSentences(openaiKey: string, sentences: string[]): Promise<number[][]> {
  return await generateEmbeddings(openaiKey, sentences);
}

function computePairwiseSimilarities(embeddings: number[][]): number[] {
  const sims: number[] = [];
  for (let i = 1; i < embeddings.length; i++) {
    sims.push(cosineSimilarity(embeddings[i - 1], embeddings[i]));
  }
  return sims;
}

function detectBreakPoints(
  similarities: number[],
  sentenceCount: number,
  opts: ResolvedOptions
): number[] {
  if (similarities.length === 0) {
    return [];
  }

  const smoothed = smooth(similarities, opts.smoothWindow);
  const mean = smoothed.reduce((sum, sim) => sum + sim, 0) / smoothed.length;
  const variance = smoothed.reduce((sum, sim) => sum + Math.pow(sim - mean, 2), 0) / smoothed.length;
  const std = Math.sqrt(Math.max(variance, 0));
  const dynamicThreshold = std > 0 ? mean - opts.stdMultiplier * std : mean - 0.05;
  const threshold = Math.max(-1, Math.min(dynamicThreshold, mean));
  const breakPoints: number[] = [];

  let lastBreak = 0;
  for (let i = 0; i < similarities.length; i++) {
    const current = smoothed[i];
    const previous = i > 0 ? smoothed[i - 1] : mean;
    const drop = previous - current;

    const shouldBreak =
      (drop > opts.similarityDrop && current < previous) || current < threshold;

    const enoughSentences = i + 1 - lastBreak >= 2;
    const notTooCloseToEnd = i + 1 < sentenceCount - 1;

    if (shouldBreak && enoughSentences && notTooCloseToEnd) {
      breakPoints.push(i + 1);
      lastBreak = i + 1;
    }
  }

  return breakPoints;
}

function buildSegments(sentences: string[], breakPoints: number[]): string[] {
  if (breakPoints.length === 0) {
    return [sentences.join(' ').trim()];
  }

  const sortedBreaks = Array.from(new Set(breakPoints)).sort((a, b) => a - b);
  const segments: string[] = [];

  let start = 0;
  for (const bp of sortedBreaks) {
    if (bp <= start || bp >= sentences.length) continue;
    const piece = sentences.slice(start, bp).join(' ').trim();
    if (piece) segments.push(piece);
    start = bp;
  }

  const tail = sentences.slice(start).join(' ').trim();
  if (tail) segments.push(tail);

  return segments;
}

async function mergeSegments(
  openaiKey: string,
  segments: string[],
  opts: ResolvedOptions
): Promise<Array<{ text: string; sentenceCount: number }>> {
  if (segments.length === 0) {
    return [];
  }

  const cache = new Map<string, number>();
  const tokensFor = async (text: string) => {
    if (cache.has(text)) return cache.get(text)!;
    const value = await countTokens(openaiKey, text);
    cache.set(text, value);
    return value;
  };

  const chunks: Array<{ text: string; sentenceCount: number }> = [];
  let current = '';
  let sentenceTally = 0;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const parts = await enforceMaxSize(trimmed, openaiKey, opts.maxTokens, tokensFor);
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      const candidateTokens = await tokensFor(candidate);

      if (candidateTokens > opts.maxTokens && current) {
        if (current.trim()) {
          chunks.push({ text: current, sentenceCount: sentenceTally });
        }
        current = part;
        sentenceTally = countSentences(part);
        continue;
      }

      current = candidate;
      sentenceTally += countSentences(part);

      if (candidateTokens >= opts.targetTokens) {
        chunks.push({ text: current, sentenceCount: sentenceTally });
        current = '';
        sentenceTally = 0;
      }
    }
  }

  if (current.trim()) {
    chunks.push({ text: current, sentenceCount: sentenceTally });
  }

  return await normalizeSmallChunks(chunks, opts, tokensFor);
}

async function normalizeSmallChunks(
  chunks: Array<{ text: string; sentenceCount: number }>,
  opts: ResolvedOptions,
  tokensFor: (text: string) => Promise<number>
): Promise<Array<{ text: string; sentenceCount: number }>> {
  if (chunks.length <= 1) return chunks;

  const normalized: Array<{ text: string; sentenceCount: number }> = [];

  for (const chunk of chunks) {
    const tokens = await tokensFor(chunk.text);
    if (tokens < opts.minTokens && normalized.length > 0) {
      const previous = normalized[normalized.length - 1];
      const mergedText = `${previous.text}\n\n${chunk.text}`;
      const mergedTokens = await tokensFor(mergedText);
      if (mergedTokens <= opts.maxTokens) {
        normalized[normalized.length - 1] = {
          text: mergedText,
          sentenceCount: previous.sentenceCount + chunk.sentenceCount,
        };
        continue;
      }
    }
    normalized.push(chunk);
  }

  return normalized;
}

async function enforceMaxSize(
  text: string,
  openaiKey: string,
  maxTokens: number,
  tokensFor: (text: string) => Promise<number>
): Promise<string[]> {
  const tokenCount = await tokensFor(text);
  if (tokenCount <= maxTokens) {
    return [text];
  }

  const splitIndex = findSplitPoint(text);
  if (splitIndex <= 0 || splitIndex >= text.length - 1) {
    return [text];
  }

  const left = text.slice(0, splitIndex).trim();
  const right = text.slice(splitIndex).trim();
  const pieces: string[] = [];

  if (left) {
    pieces.push(...(await enforceMaxSize(left, openaiKey, maxTokens, tokensFor)));
  }
  if (right) {
    pieces.push(...(await enforceMaxSize(right, openaiKey, maxTokens, tokensFor)));
  }

  return pieces.length > 0 ? pieces : [text];
}

function findSplitPoint(text: string): number {
  const midpoint = Math.floor(text.length / 2);
  const candidates = [
    text.lastIndexOf('\n\n', midpoint),
    text.indexOf('\n\n', midpoint + 1),
    text.lastIndexOf('. ', midpoint),
    text.indexOf('. ', midpoint + 1),
    text.lastIndexOf('! ', midpoint),
    text.lastIndexOf('? ', midpoint),
  ].filter(index => index > 0);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const index of candidates) {
    const distance = Math.abs(midpoint - index);
    const tooCloseToEdge = index < 200 || index > text.length - 200;
    if (!tooCloseToEdge && distance < bestDistance) {
      bestDistance = distance;
      best = index + 1;
    }
  }

  if (best === -1) {
    best = midpoint;
  }

  return best;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function countSentences(text: string): number {
  return splitIntoSentences(text).length || 1;
}

function smooth(values: number[], windowRadius: number): number[] {
  if (values.length === 0 || windowRadius <= 0) return [...values];
  return values.map((_, index) => {
    const start = Math.max(0, index - windowRadius);
    const end = Math.min(values.length - 1, index + windowRadius);
    const slice = values.slice(start, end + 1);
    const total = slice.reduce((sum, value) => sum + value, 0);
    return total / slice.length;
  });
}
