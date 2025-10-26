export interface TextChunk {
  text: string;
  metadata?: {
    startLine?: number;
    endLine?: number;
    language?: string;
    header?: string;
  };
}

const SLIDING_WINDOW_SIZE = 1000;
const SLIDING_WINDOW_OVERLAP = 200;

export function chunkCode(
  content: string,
  language?: string
): TextChunk[] {
  const lines = content.split('\n');
  const chunks: TextChunk[] = [];
  
  let currentChunk: string[] = [];
  let startLine = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFunctionStart = isFunctionDefinition(line);
    const isClassStart = isClassDefinition(line);
    
    if ((isFunctionStart || isClassStart) && currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.join('\n'),
        metadata: {
          startLine: startLine + 1,
          endLine: i,
          language,
        },
      });
      
      currentChunk = [line];
      startLine = i;
    } else {
      currentChunk.push(line);
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk.join('\n'),
      metadata: {
        startLine: startLine + 1,
        endLine: lines.length,
        language,
      },
    });
  }
  
  return chunks.length > 0 ? chunks : [{
    text: content,
    metadata: { language },
  }];
}

function isFunctionDefinition(line: string): boolean {
  return /^\s*(export\s+)?(async\s+)?function\s+\w+/.test(line) ||
         /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/.test(line) ||
         /^\s*(export\s+)?\w+\s*:\s*(async\s+)?\(/.test(line);
}

function isClassDefinition(line: string): boolean {
  return /^\s*(export\s+)?class\s+\w+/.test(line) ||
         /^\s*(export\s+)?interface\s+\w+/.test(line) ||
         /^\s*(export\s+)?type\s+\w+/.test(line);
}

export function chunkMarkdown(content: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = content.split('\n');
  
  let currentChunk: string[] = [];
  let currentHeader: string | undefined;
  let startLine = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    
    if (headerMatch) {
      if (currentChunk.length > 0) {
        chunks.push({
          text: currentChunk.join('\n'),
          metadata: {
            startLine: startLine + 1,
            endLine: i,
            header: currentHeader,
          },
        });
      }
      
      currentHeader = headerMatch[2];
      currentChunk = [line];
      startLine = i;
    } else {
      currentChunk.push(line);
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk.join('\n'),
      metadata: {
        startLine: startLine + 1,
        endLine: lines.length,
        header: currentHeader,
      },
    });
  }
  
  return chunks.length > 0 ? chunks : [{
    text: content,
  }];
}

export function chunkText(content: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const words = content.split(/\s+/);
  const wordsPerChunk = SLIDING_WINDOW_SIZE;
  const overlapWords = SLIDING_WINDOW_OVERLAP;
  
  for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
    const chunkWords = words.slice(i, i + wordsPerChunk);
    chunks.push({
      text: chunkWords.join(' '),
    });
    
    if (i + wordsPerChunk >= words.length) {
      break;
    }
  }
  
  return chunks.length > 0 ? chunks : [{ text: content }];
}

export function detectLanguage(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'sh': 'bash',
    'html': 'html',
    'css': 'css',
    'sql': 'sql',
  };
  
  return ext ? languageMap[ext] : undefined;
}

