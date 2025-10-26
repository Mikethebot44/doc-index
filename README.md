# Document Indexing SDK

Index and search code and documentation using vector embeddings with OpenAI and Pinecone.

## Features

- Index GitHub repositories for intelligent code search
- Index documentation from any URL using Firecrawl
- Natural language search across your indexed resources
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
export FIRECRAWL_API_KEY="your-firecrawl-key"  # Optional, for documentation
export GITHUB_TOKEN="your-github-token"  # Optional, for private repos
```

## CLI Usage

### Index a GitHub Repository

```bash
doc-index index-repo https://github.com/owner/repo --branch main
```

Options:
- `--branch <branch>` - Branch to index (default: main)
- `--include <paths...>` - Include only these paths
- `--exclude <paths...>` - Exclude these paths

### Search Codebase

```bash
doc-index search-code "how to handle authentication"
```

Options:
- `-r, --repos <repos...>` - Limit to specific repositories
- `-l, --limit <limit>` - Max results (default: 10)
- `--lang <langs...>` - Filter by language

Example:
```bash
doc-index search-code "error handling pattern" --lang typescript javascript
```

### Index Documentation

```bash
doc-index index-docs https://docs.example.com
```

Options:
- `-m, --max-pages <max>` - Maximum pages to crawl

### Search Documentation

```bash
doc-index search-docs "how to configure the API"
```

Options:
- `-s, --sources <sources...>` - Limit to specific sources
- `-l, --limit <limit>` - Max results (default: 10)

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
  firecrawlKey: process.env.FIRECRAWL_API_KEY,
  githubToken: process.env.GITHUB_TOKEN,
});
```

### Index a Repository

```typescript
const resourceId = await sdk.indexRepository(
  'https://github.com/owner/repo',
  {
    branch: 'main',
    includePaths: ['src/'],
    excludePaths: ['node_modules/', 'dist/'],
  },
  (current, total) => {
    console.log(`Progress: ${current}/${total}`);
  }
);

console.log('Indexed:', resourceId);
```

### Search Codebase

```typescript
const results = await sdk.searchCodebase(
  'how to handle authentication errors',
  ['repo:owner/repo:main'],
  {
    limit: 10,
    filter: {
      language: ['typescript', 'javascript'],
    },
  }
);

results.forEach(result => {
  console.log(result.metadata.filePath);
  console.log(result.score);
  console.log(result.metadata.content);
});
```

### Index Documentation

```typescript
const resourceId = await sdk.indexDocumentation(
  'https://docs.example.com',
  {
    maxPages: 100,
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
- **Octokit**: Fetches repository files from GitHub

### Chunking Strategy

- **Code files**: Parsed by function/class boundaries
- **Markdown**: Split by headers (H1, H2, H3)
- **Plain text**: Sliding window with 200 token overlap

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
