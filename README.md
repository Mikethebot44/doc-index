# Document Indexing SDK

Index, enrich, and search documentation using OpenAI embeddings, Pinecone vector storage, and Firecrawl crawling.

## Features

- Index any documentation URL in the foreground or queue it for background processing
- Control crawls with prompts plus include/exclude filters, and receive structured progress logs
- Semantic chunking keeps sentence-level context together for improved recall
- Natural language search with grouped or raw results, optional page reconstruction, and source filtering
- Firecrawl-powered discovery for new documentation sources from the web, GitHub, or academic sites
- Summaries powered by OpenAI with automatic token-aware content trimming
- Background job tracking with resumable history, log streaming, and metadata repairs
- Resource management utilities to list, rename, delete, or inspect indexed sources
- Agent mode that can search, summarize, find, or index docs on demand
- Full programmatic API mirroring CLI capabilities

## Installation

```bash
npm install doc-index-sdk
```

## Setup

Set the required environment variables before using the CLI or SDK:

```bash
export OPENAI_API_KEY="your-openai-key"
export PINECONE_API_KEY="your-pinecone-key"
export FIRECRAWL_API_KEY="your-firecrawl-key"
```

Optional environment variables:

- `PINECONE_INDEX_NAME` – override the default `doc-index` namespace
- `DOC_INDEX_HOME` – customise where background job history is stored (defaults to `~/.doc-index/jobs.json`)

## CLI Usage

All commands are available through the `doc-index` binary that ships with the package. Run `doc-index --help` for the full command list.

### Index Documentation

```bash
doc-index index-docs https://docs.example.com "Ignore marketing and blog pages"
```

Options:

- `-m, --max-pages <max>` – maximum pages to crawl (default: 100)
- `-p, --prompt <prompt>` – override the inline prompt argument
- `-i, --include <paths...>` – only crawl URLs containing these substrings
- `-e, --exclude <paths...>` – skip URLs containing these substrings
- `-b, --background` – enqueue the crawl to run in a detached worker

Foreground runs stream progress updates (`Progress: <current>/<total> chunks indexed`) and Firecrawl logs in place. When `--background` is used the command exits immediately after queuing and prints the job ID and resource ID so you can monitor it later.

### Track Jobs and Resources

```bash
# List all indexed resources and their metadata
doc-index list

# Check the status of a job or resource
doc-index status <job-id|resource-id>

# Rename or delete a resource
doc-index rename <resource-id> "New Display Name"
doc-index delete <resource-id>
```

`doc-index status` works for both job IDs (e.g. `job_123...`) and resource IDs (`doc:https://...`). For jobs the CLI prints progress, timestamps, recent logs, and the associated resource. For resources it shows the latest chunk counts, timestamps, and error state if present.

### Search Documentation

```bash
doc-index search-docs "how to configure the API"
```

Options:

- `-s, --sources <sources...>` – limit to specific resource IDs
- `-l, --limit <limit>` – maximum results (default: 10)
- `--grouped` – return grouped matches by page URL
- `--return-page` – include reconstructed page markdown alongside grouped results

By default, search results are reranked using Pinecone’s hosted Cohere Rerank 3.5 model for higher precision. The CLI uses defaults; you can customize reranking via the SDK.

### Summarize Documentation

```bash
doc-index summarize-docs "kicking off ingestion"
```

Options:

- `--top <n>` – number of top-ranked pages to summarise (default: 3)
- `--model <model>` – OpenAI model alias for summarisation (default: `gpt-5-mini`)

### Find Docs on the Web

```bash
doc-index find-docs "How to build GraphQL APIs in Next.js"
```

Options:

- `-l, --limit <limit>` – maximum results (default: 10)
- `--github` – include GitHub repositories and discussions
- `--research` – include academic and research sources
- `--pdf` – include PDF documents when available

### Ask the Agent

```bash
doc-index ask-agent "How do I integrate Stripe Sigma?"
```

Options:

- `--model <model>` – underlying LLM alias (default: `gpt-5-mini`)
- `--steps <count>` – maximum tool round-trips (default: 4)
- `--temperature <value>` – sampling temperature (default: 0.2)
- `--include-resources` – provide the resource list as context for the agent

The agent can call into search, summarisation, find-docs, or indexing tools as needed to answer questions.

## Programmatic Usage

### Instantiate the SDK

```typescript
import { DocIndexSDK } from 'doc-index-sdk';

const sdk = new DocIndexSDK({
  openaiKey: process.env.OPENAI_API_KEY!,
  pineconeKey: process.env.PINECONE_API_KEY!,
  firecrawlKey: process.env.FIRECRAWL_API_KEY!,
  pineconeIndexName: process.env.PINECONE_INDEX_NAME,
});
```

### Index Documentation (Foreground)

```typescript
const resourceId = await sdk.indexDocumentation(
  'https://docs.example.com',
  {
    maxPages: 150,
    prompt: 'Focus on API reference pages and skip marketing content.',
    includePaths: ['/api', '/guides'],
    excludePaths: ['/blog', '/changelog'],
  },
  (current, total) => {
    console.log(`Indexed ${current}/${total} chunks`);
  },
  (message, level) => {
    if (level === 'error') {
      console.error(message);
    } else {
      console.log(message);
    }
  },
);
```

### Index Documentation (Background Queue)

```typescript
const job = await sdk.enqueueIndexDocumentation(
  'https://docs.example.com',
  { maxPages: 100 },
);

console.log('Queued job:', job.id);

// Later on:
const details = await sdk.getIndexJob(job.id);
console.log(details?.status, details?.progress);
```

Additional helpers:

- `await sdk.listIndexJobs()` – fetch persisted job history
- `await sdk.checkResourceStatus(resourceId)` – latest metadata for an indexed resource

### Search and Summarise

```typescript
const searchResults = await sdk.searchDocumentation(
  'how to configure the API endpoint',
  ['doc:https://docs.example.com'],
  {
    limit: 5,
    // Reranking options (optional; defaults shown)
    rerankEnabled: true,
    rerankModel: 'cohere-rerank-3.5',
    rerankTopN: 5,
  },
);

const grouped = await sdk.searchDocumentationGrouped('webhooks', {
  limit: 3,
  returnPage: true,
});

const summary = await sdk.summarizeDocumentation('kick off ingestion flow', {
  topPages: 3,
  model: 'gpt-5-mini',
});
```

### Discover New Sources

```typescript
const links = await sdk.findDocs('Most recent Supabase PRs', {
  limit: 5,
  includeGithub: true,
});
```

### Ask the Agent

```typescript
const answer = await sdk.askAgent('How do I integrate Stripe Sigma?', {
  model: 'gpt-5-mini',
  includeResourceList: true,
  maxToolRoundtrips: 4,
});
console.log(answer);
```

### Manage Resources

```typescript
const resources = await sdk.listResources();
const resource = await sdk.getResource('doc:https://docs.example.com');

await sdk.renameResource('doc:https://docs.example.com', 'Example Docs');
await sdk.deleteResource('doc:https://docs.example.com');
```

## Architecture

- **OpenAI**: Generates text embeddings using `text-embedding-3-large`
- **Pinecone**: Stores and queries vectors with cosine similarity; optionally reranks candidates via hosted models (Cohere Rerank 3.5)
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
