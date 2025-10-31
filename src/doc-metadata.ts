import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { toString as nodeToString } from 'mdast-util-to-string';
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SemanticDocumentMetadata } from './types';

const semanticDocSchema = z.object({
  primaryPurpose: z.string().min(1).max(512),
  audience: z.string().min(1).max(256).optional().default('general'),
  topics: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  complexity: z.enum(['low', 'medium', 'high', 'unknown']).optional().default('unknown'),
  hasCodeExamples: z.boolean().optional().default(false),
  contentType: z.string().min(1).max(128).optional().default('documentation'),
});

export interface MarkdownDocumentMetadata {
  url: string;
  path?: string;
  headings: string[];
  summary: string;
  links: string[];
  codeLanguages: string[];
  wordCount: number;
  structureDepth: number;
  topics: string[];
}

function dedupe(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed.slice(0, 160));
      if (seen.size >= limit) break;
    }
  }
  return Array.from(seen);
}

export function extractMarkdownMetadata(
  source: string,
  options: { url: string; path?: string }
): MarkdownDocumentMetadata {
  const headings: string[] = [];
  const links: string[] = [];
  const codeLanguages: string[] = [];
  const paragraphs: string[] = [];

  const tree = unified().use(remarkParse).parse(source);

  visit(tree as any, (node: any) => {
    if (node.type === 'heading' && node.depth && node.depth <= 3) {
      const headingText = nodeToString(node);
      if (headingText) headings.push(headingText);
    }
    if (node.type === 'link' && typeof (node as any).url === 'string') {
      links.push((node as any).url);
    }
    if (node.type === 'code') {
      const lang = (node as any).lang;
      if (typeof lang === 'string' && lang.trim().length > 0) {
        codeLanguages.push(lang.trim());
      }
    }
    if (node.type === 'paragraph') {
      const paragraph = nodeToString(node);
      if (paragraph) {
        paragraphs.push(paragraph);
      }
    }
  });

  const wordCount = paragraphs
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;

  const summary = paragraphs[0]?.slice(0, 600) ?? '';
  const structureDepth = Math.max(1, headings.length);

  return {
    url: options.url,
    path: options.path,
    headings: dedupe(headings, 32),
    summary,
    links: dedupe(links, 32),
    codeLanguages: dedupe(codeLanguages, 16),
    wordCount,
    structureDepth,
    topics: dedupe(headings.map(h => h.toLowerCase()), 16),
  };
}

function buildDocPrompt(data: MarkdownDocumentMetadata): string {
  const parts: string[] = [
    `Document URL: ${data.url}`,
    data.path ? `Path: ${data.path}` : '',
    `Headings: ${data.headings.slice(0, 12).join(' | ') || 'None'}`,
    `Summary: ${data.summary || 'None'}`,
    `Code languages: ${data.codeLanguages.join(', ') || 'none'}`,
    `Links: ${data.links.slice(0, 10).join(', ') || 'none'}`,
    `Word count: ${data.wordCount}`,
    `Structure depth (headings count <=3): ${data.structureDepth}`,
    `Topics: ${data.topics.join(', ') || 'None'}`,
    'Return a JSON object describing the document purpose, intended audience, key topics, complexity, and whether it contains code examples.',
  ].filter(Boolean);

  return parts.join('\n\n');
}

export async function generateSemanticDocMetadata(
  openaiKey: string,
  data: MarkdownDocumentMetadata,
  options: { model?: string } = {}
): Promise<SemanticDocumentMetadata | undefined> {
  try {
    const openai = createOpenAI({ apiKey: openaiKey });
    const modelName = options.model ?? 'gpt-4o-mini';

    const { object } = await generateObject({
      model: openai(modelName) as any,
      schema: semanticDocSchema,
      system:
        'You are a documentation analyst. Respond only with valid JSON that matches the provided schema.',
      prompt: buildDocPrompt(data),
    });

    const parsed = semanticDocSchema.parse(object);

    const mergedTopics = dedupe([...(parsed.topics ?? []), ...data.topics], 16);

    return {
      url: data.url,
      path: data.path,
      headings: data.headings,
      primaryPurpose: parsed.primaryPurpose.trim(),
      audience: parsed.audience?.trim() ?? 'general',
      topics: mergedTopics,
      complexity: parsed.complexity ?? 'unknown',
      hasCodeExamples: Boolean(parsed.hasCodeExamples),
      contentType: parsed.contentType?.trim() ?? 'documentation',
    };
  } catch (error) {
    if (process.env.DOC_INDEX_DEBUG === '1') {
      console.warn('Semantic doc metadata generation failed:', error);
    }
    return undefined;
  }
}
