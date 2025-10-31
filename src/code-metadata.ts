import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SemanticFileMetadata } from './types';

const semanticMetadataSchema = z.object({
  primaryPurpose: z.string().min(1).max(512),
  architectureRole: z.string().min(1).max(256),
  dependsOn: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  interactionType: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  complexity: z.enum(['low', 'medium', 'high', 'unknown']).optional().default('unknown'),
  keyEntities: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  exports: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
});

export interface SemanticMetadataInput {
  path: string;
  language: string;
  functions: string[];
  imports: string[];
  exports: string[];
  docstring?: string;
  fileSummary?: string;
}

interface SemanticMetadataResult {
  primaryPurpose: string;
  architectureRole: string;
  dependsOn: string[];
  interactionType: string[];
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  keyEntities: string[];
  exports: string[];
}

function normalizeArray(values: string[] | undefined, limit: number): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .map(value => value?.toString?.().trim())
    .filter((value): value is string => Boolean(value) && value.length > 0)
    .map(value => value.slice(0, 160));
  const unique = Array.from(new Set(normalized));
  return unique.slice(0, limit);
}

function buildPrompt(input: SemanticMetadataInput): string {
  const parts: string[] = [
    `File path: ${input.path}`,
    `Language: ${input.language}`,
  ];

  if (input.functions.length > 0) {
    parts.push(`Functions or symbols: ${input.functions.slice(0, 12).join(', ')}`);
  }
  if (input.imports.length > 0) {
    parts.push(`Imports: ${input.imports.slice(0, 12).join(', ')}`);
  }
  if (input.exports.length > 0) {
    parts.push(`Exports: ${input.exports.slice(0, 12).join(', ')}`);
  }
  if (input.docstring && input.docstring.trim().length > 0) {
    parts.push(`Comments: ${input.docstring.trim().slice(0, 300)}`);
  }
  if (input.fileSummary && input.fileSummary.trim().length > 0) {
    parts.push(`File summary:\n${input.fileSummary.trim().slice(0, 600)}`);
  }

  parts.push(
    'Return a JSON object describing the file purpose and behaviour based on the provided schema.'
  );

  return parts.join('\n\n');
}

export async function generateSemanticFileMetadata(
  openaiKey: string,
  input: SemanticMetadataInput,
  options: { model?: string } = {}
): Promise<SemanticFileMetadata | undefined> {
  try {
    const openai = createOpenAI({ apiKey: openaiKey });
    const modelName = options.model ?? 'gpt-4o-mini';

    const { object } = await generateObject({
      model: openai(modelName) as any,
      schema: semanticMetadataSchema,
      system:
        'You are a precise code analysis engine. Respond only with valid JSON that matches the provided schema.',
      prompt: buildPrompt(input),
    });

    const parsed = object as SemanticMetadataResult;

    const primaryPurpose = parsed.primaryPurpose?.trim() ?? '';
    const architectureRole = parsed.architectureRole?.trim() ?? '';
    if (!primaryPurpose || !architectureRole) {
      return undefined;
    }

    const semantic: SemanticFileMetadata = {
      path: input.path,
      language: input.language,
      primaryPurpose,
      architectureRole,
      dependsOn: normalizeArray(parsed.dependsOn, 16),
      interactionType: normalizeArray(parsed.interactionType, 16),
      complexity: parsed.complexity ?? 'unknown',
      keyEntities: normalizeArray(parsed.keyEntities, 16),
      exports: normalizeArray(parsed.exports, 32),
    };

    return semantic;
  } catch (error) {
    if (process.env.DOC_INDEX_DEBUG === '1') {
      console.warn('Semantic metadata generation failed:', error);
    }
    return undefined;
  }
}
