# Document Indexing SDK

Index and search documentation using vector embeddings with OpenAI and Pinecone.

## Features

- Index documentation from any URL using Firecrawl
- Natural language search across indexed pages
- Summarize top matching documentation hits
- Semantic chunking keeps related sentences together for better recall
- Tune crawls with prompts plus include/exclude path filters
- Track indexing progress and status
- Manage indexed resources (rename, delete, list)

## Installation

```bash
npm install doc-index-sdk
```

## Setup

Set environment variables for API keys:

```bash
export OPENAI_API_KEY="your-openai-key"
export PINECONE_API_KEY="your-pinecone-key"
export FIRECRAWL_API_KEY="your-firecrawl-key"
```

## CLI Usage

### Index Documentation

```bash
doc-index index-docs https://docs.example.com "Ignore marketing and blog pages"
```

Options:
- `-m, --max-pages <max>` - Maximum pages to crawl
- `-i, --include <paths...>` - Only crawl URLs containing these substrings
- `-e, --exclude <paths...>` - Skip URLs containing these substrings
- `-p, --prompt <prompt>` - Provide the specification prompt via flag

### Search Documentation

```bash
doc-index search-docs "how to configure the API"
```

Options:
- `-s, --sources <sources...>` - Limit to specific sources
- `-l, --limit <limit>` - Max results (default: 10)
- `--grouped` - Group hits by page URL
- `--return-page` - Return assembled page markdown for review

### Summarize Documentation

```bash
doc-index summarize-docs "kicking off ingestion"
```

Options:
- `--top <n>` - Number of pages to include (default: 3)
- `--model <model>` - OpenAI model alias (default: gpt-5-mini)

### List Resources

```bash
doc-index list
```

### Check Resource Status

```bash
doc-index status <resource-id>
```

### Rename Resource

```bash
doc-index rename <resource-id> <new-name>
```

### Delete Resource

```bash
doc-index delete <resource-id>
```

## Programmatic Usage

### Basic Setup

```typescript
import { DocIndexSDK } from 'doc-index-sdk';

const sdk = new DocIndexSDK({
  openaiKey: process.env.OPENAI_API_KEY!,
  pineconeKey: process.env.PINECONE_API_KEY!,
  firecrawlKey: process.env.FIRECRAWL_API_KEY!,
});
```

### Summarize Documentation

```typescript
const summary = await sdk.summarizeDocumentation('kick off ingestion flow', {
  topPages: 3,
  model: 'gpt-5-mini',
});
console.log(summary);
```

### Index Documentation

```typescript
const resourceId = await sdk.indexDocumentation(
  'https://docs.example.com',
  {
    maxPages: 150,
    prompt: 'Focus on API reference pages and skip marketing content.',
    includePaths: ['/api', '/guides'],
    excludePaths: ['/blog', '/changelog'],
  }
);
```

### Search Documentation

```typescript
const results = await sdk.searchDocumentation(
  'how to configure the API endpoint',
  ['doc:https://docs.example.com'],
  {
    limit: 5,
  }
);
```

### Manage Resources

```typescript
// List all resources
const resources = await sdk.listResources();

// Check status
const resource = await sdk.checkResourceStatus('resource-id');

// Rename
await sdk.renameResource('resource-id', 'New Name');

// Delete
await sdk.deleteResource('resource-id');
```

## Architecture

- **OpenAI**: Generates text embeddings using `text-embedding-3-large`
- **Pinecone**: Stores and queries vectors with cosine similarity
- **Firecrawl**: Crawls and scrapes documentation pages

### Chunking Strategy

- **Semantic markdown**: Sentence-level embeddings flag topic breaks, then chunks merge to ~1.2k tokens
- **Page anchors**: Each page stores an aggregate vector for summary retrieval
- **Token guardrails**: Long sections recursively split to stay under model limits

### Resource Tracking

Resources are tracked with status:
- `indexing`: Currently being indexed
- `ready`: Successfully indexed
- `error`: Indexing failed

## Error Handling

The SDK includes comprehensive error handling with:
- Automatic retries for rate limits (exponential backoff)
- Timeout handling
- Detailed error messages
- Progress tracking

## License

MIT

# doc-index
