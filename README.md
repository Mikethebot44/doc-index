# Document Indexing SDK

Index, enrich, and search documentation using OpenAI embeddings, Pinecone vector storage, and Firecrawl crawling.

## Features

- Index any documentation URL in the foreground or queue it for background processing
- Control crawls with prompts plus include/exclude filters, and receive structured progress logs
- Semantic chunking keeps sentence-level context together for improved recall
- Natural language search with grouped or raw results, optional page reconstruction, and source filtering
- File-level semantic metadata for both code and documentation, powered by lightweight LLM extraction
- Firecrawl-powered discovery for new documentation sources from the web, GitHub, or academic sites
- Summaries powered by OpenAI with automatic token-aware content trimming
- Background job tracking with resumable history, log streaming, and metadata repairs
- Resource management utilities to list, rename, delete, or inspect indexed sources
- Agent mode that can search, summarize, find, or index docs on demand
- Full programmatic API mirroring CLI capabilities
- Multi-namespace Pinecone support with dedicated creation and targeting tools

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
export GITHUB_TOKEN="your-github-token"   # required for GitHub repository indexing
```

Optional environment variables:

- `PINECONE_INDEX_NAME` – override the default Pinecone index name (`doc-index`)
- `PINECONE_NAMESPACE` (or legacy `DOC_INDEX_NAMESPACE`) – default namespace to scope CLI/SDK operations (`__default__` if omitted)
- `DOC_INDEX_HOME` – customise where background job history is stored (defaults to `~/.doc-index/jobs.json`)
- `DOC_INDEX_GITHUB_TOKEN` – alternative variable the CLI checks for a GitHub token if `GITHUB_TOKEN` is unset

## Working With Namespaces

Namespaces let you segment vectors within a single Pinecone index (for example by environment, product line, or customer). If you do not specify one, the SDK falls back to the sentinel namespace `__default__`.

### Create a Namespace

Use the CLI to create a placeholder vector so Pinecone recognises the namespace:

```bash
doc-index create-namespace docs-team \
  --description "Primary documentation corpus" \
  --metadata '{"owner":"docs@example.com"}'
```

Options:

- `-d, --description <description>` – human-readable description stored as metadata
- `-m, --metadata <json>` – additional JSON metadata merged into the placeholder vector
- `-p, --placeholder-id <id>` – custom placeholder vector ID (defaults to `__namespace__:<name>`)

Programmatically you can call:

```typescript
await sdk.createNamespace('docs-team', {
  description: 'Primary documentation corpus',
  metadata: { owner: 'docs@example.com' },
  // placeholderId is optional; defaults to "__namespace__:<name>"
  placeholderId: '__namespace__:docs-team',
});
```

The SDK method mirrors the CLI flags. Pass `description`, `metadata`, and `placeholderId` as fields on the second argument to control the stored metadata and placeholder vector ID.

### Target a Namespace

Most CLI commands accept `-n, --namespace <name>`; when omitted, the CLI uses `PINECONE_NAMESPACE` and finally `__default__`. The SDK mirrors this behaviour through optional `namespace` arguments.

Examples:

```bash
doc-index index-docs https://docs.example.com --namespace docs-team
doc-index search-docs "webhook retries" --namespace staging
doc-index summarize-docs "rollout plan" --namespace prod
```

Mutating operations (indexing, enqueuing jobs, renaming, deleting resources) require a namespace. The SDK throws if none is provided, so make sure to pass `namespace` explicitly or configure `pineconeNamespace` when instantiating `DocIndexSDK`.

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
- `-n, --namespace <name>` – Pinecone namespace to target (default: `__default__`)

Foreground runs stream progress updates (`Progress: <current>/<total> chunks indexed`) and Firecrawl logs in place. When `--background` is used the command exits immediately after queuing and prints the job ID and resource ID so you can monitor it later.

Behind the scenes the SDK now produces *both* file-level and snippet-level embeddings for each documentation page. A lightweight MDAST pass extracts headings, links, and code languages; a fast LLM call infers semantic attributes (purpose, audience, complexity, topics), and these are embedded alongside the existing sentence-aware snippet chunks. The result is hierarchical retrieval parity with code repositories—high-level doc summaries surface quickly while deeper snippets remain available for precise answers.

### Index a GitHub Repository

```bash
doc-index index-repo https://github.com/firecrawl/firecrawl \
  --branch canary \
  --lang ts tsx \
  --max-files 250 \
  --namespace repos \
  --enrich-metadata
```

The CLI fetches the repository via the GitHub API, extracts lightweight symbol metadata, embeds file- and snippet-level representations, and stores them in Pinecone under the namespace you provide. Key flags:

- `-r, --branch <name>` – branch to index (default: `main`)
- `--lang <languages...>` – restricts files by language/extension (for example `ts`, `tsx`, `py`)
- `--max-files <count>` – hard cap on the number of files to embed (default: 1000)
- `--max-file-size <kb>` – skip files larger than the given size in kilobytes (default: 100)
- `--enrich-metadata` – invoke an LLM to infer semantic metadata before embedding
- `-n, --namespace <name>` – Pinecone namespace for the vectors (default: `__default__`)

Add `--background` to queue the job and let the detached worker process it. Track progress with `doc-index status <job-id>`. Combine with `--enrich-metadata` to capture semantic file summaries in the background.

### Search Indexed Code

```bash
doc-index search-code "verify jwt token middleware" \
  --repo vercel/next.js \
  --namespace repos
```

The search command runs hierarchical retrieval: it queries both file-level vectors and snippet-level vectors, then merges and ranks the matches so you can jump straight to the most relevant symbol or file. Options:

- `-r, --repo <owner/repo>` – limit to a specific repository slug
- `--files <count>` – number of file-level matches to request (default: 8)
- `--snippets <count>` – number of snippet-level matches to request (default: 16)
- `-n, --namespace <name>` – namespace to search (default: `__default__`)

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
- `-n, --namespace <name>` – Pinecone namespace to query (default: `__default__`)

By default, search results are reranked using Pinecone’s hosted Cohere Rerank 3.5 model for higher precision. The CLI uses defaults; you can customize reranking via the SDK.

### Summarize Documentation

```bash
doc-index summarize-docs "kicking off ingestion"
```

Options:

- `--top <n>` – number of top-ranked pages to summarise (default: 3)
- `--model <model>` – OpenAI model alias for summarisation (default: `gpt-5-mini`)
- `-n, --namespace <name>` – Pinecone namespace to query (default: `__default__`)

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
- `-n, --namespace <name>` – Pinecone namespace the agent should operate within (default: `__default__`)

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
  pineconeImageIndexName: process.env.PINECONE_IMAGE_INDEX_NAME,
  pineconeNamespace: process.env.PINECONE_NAMESPACE,
  githubToken: process.env.GITHUB_TOKEN || process.env.DOC_INDEX_GITHUB_TOKEN,
});
```

### Create a Namespace (SDK)

```typescript
await sdk.createNamespace('docs-team', {
  description: 'Primary documentation corpus',
  metadata: { owner: 'docs@example.com' },
  placeholderId: '__namespace__:docs-team', // optional
});
```

- `description` (string) – stored in the placeholder vector metadata
- `metadata` (object) – arbitrary key/value metadata appended to the placeholder
- `placeholderId` (string) – override the default `__namespace__:<name>` vector ID

### Index Documentation (Foreground)

```typescript
const resourceId = await sdk.indexDocumentation(
  'https://docs.example.com',
  {
    maxPages: 150,
    prompt: 'Focus on API reference pages and skip marketing content.',
    includePaths: ['/api', '/guides'],
    excludePaths: ['/blog', '/changelog'],
    namespace: 'docs-team',
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
  { maxPages: 100, namespace: 'docs-team' },
);

console.log('Queued job:', job.id);

// Later on:
const details = await sdk.getIndexJob(job.id);
console.log(details?.status, details?.progress);
```

Additional helpers:

- `await sdk.listIndexJobs()` – fetch persisted job history
- `await sdk.checkResourceStatus(resourceId)` – latest metadata for an indexed resource

### Index Audio Sources (Foreground)

```typescript
const resourceId = await sdk.index(
  {
    source: '/recordings/all-hands.mp3',
    namespace: 'docs-team',
    name: 'All Hands – March 2025',
  },
  (current, total) => {
    console.log(`Embedded ${current}/${total} transcript chunks`);
  },
  message => console.log(message),
);
```

Under the hood, the SDK detects that the input is audio, transcribes it with the
Vercel AI SDK Whisper models, embeds the resulting transcript using
`text-embedding-3-large`, and stores the vectors with `modality: 'audio'` metadata
in Pinecone. Non-audio sources currently throw so it is safe to gate pipelines on
this call today.

### Index Image Sources (Foreground)

```typescript
const imageId = await sdk.index(
  {
    source: 'assets/diagrams/ingestion.png',
    namespace: 'docs-team',
    name: 'Ingestion diagram',
    description: 'Data ingestion pipeline overview diagram',
    metadata: {
      url: 'https://docs.example.com/assets/ingestion.png',
    },
  },
  undefined,
  message => console.log(message),
);
```

Images are embedded with OpenAI CLIP (`clip-embedding-1`) and written to a
separate Pinecone index (512 dimensions). Resource metadata is still managed in
the primary text index so downstream tooling can discover assets alongside
transcripts and documents.

### Search and Summarise

```typescript
const searchResults = await sdk.searchDocumentation(
  'how to configure the API endpoint',
  ['doc:https://docs.example.com'],
  {
    limit: 5,
    namespace: 'docs-team',
    // Reranking options (optional; defaults shown)
    rerankEnabled: true,
    rerankModel: 'cohere-rerank-3.5',
    rerankTopN: 5,
  },
);

const grouped = await sdk.searchDocumentationGrouped('webhooks', {
  limit: 3,
  returnPage: true,
  namespace: 'docs-team',
});

// Audio queries: supply a buffer and the SDK will transcribe then search
import { readFile } from 'fs/promises';

const audioQueryResults = await sdk.query({
  data: await readFile('/recordings/snippet.wav'),
  mimeType: 'audio/wav',
  filename: 'snippet.wav',
}, { namespace: 'docs-team' });

// Image queries: provide binary data and retrieve visually similar assets
const imageQueryResults = await sdk.query({
  data: await readFile('assets/pipeline.png'),
  mimeType: 'image/png',
  filename: 'pipeline.png',
}, { namespace: 'docs-team' });

// Text queries now perform late-fusion over text + image indices using
// confidence-weighted scores, so diagram hits surface alongside prose.

const summary = await sdk.summarizeDocumentation('kick off ingestion flow', {
  topPages: 3,
  model: 'gpt-5-mini',
  namespace: 'docs-team',
  rerankEnabled: false,
});

// Each result now carries file-level metadata such as primaryPurpose, audience, topics, etc.
console.log(searchResults[0].metadata.primaryPurpose);
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
  namespace: 'docs-team',
});
console.log(answer);
```

### Manage Resources

```typescript
const resources = await sdk.listResources('docs-team');
const resource = await sdk.getResource('doc:https://docs.example.com', 'docs-team');

await sdk.renameResource('doc:https://docs.example.com', 'Example Docs', 'docs-team');
await sdk.deleteResource('doc:https://docs.example.com', 'docs-team');
```

> **Tip:** Mutating helpers (`renameResource`, `deleteResource`, `enqueueIndexDocumentation`, etc.) operate on the namespace configured on the SDK instance. Instantiate `new DocIndexSDK({ ..., pineconeNamespace: 'docs-team' })` or pass an explicit namespace argument when you need to target a different namespace.

### Index a GitHub Repository

```typescript
const repoResult = await sdk.indexRepo(
  'https://github.com/vercel/next.js',
  {
    branch: 'canary',
    languages: ['ts', 'tsx'],
    maxFiles: 250,
    namespace: 'repos',
    enrichMetadata: true,
  },
  (current, total) => {
    console.log(`Progress: ${current}/${total}`);
  }
);

console.log(repoResult.filesIndexed, 'files indexed');
console.log(repoResult.snippetsIndexed, 'snippets indexed');
console.log(repoResult.metadataEnriched, 'files enriched');
```

The SDK automatically cleans up any previous vectors for the repository namespace combination before uploading new embeddings. Provide `maxFileSizeKb` if you need to clamp large files (defaults to 100 KB).

Queue the same work without blocking the current process:

```typescript
const job = await sdk.enqueueIndexRepo('vercel/next.js', {
  branch: 'canary',
  namespace: 'repos',
  enrichMetadata: true,
});

console.log('Queued repo job:', job.id);
```

### Search an Indexed Codebase

```typescript
const codeResult = await sdk.searchCodebase('verify jwt token middleware', {
  repo: 'vercel/next.js',
  topFileResults: 8,
  topSnippetResults: 16,
  namespace: 'repos',
});

const [first] = codeResult.matches;
if (first) {
  console.log(`Top match (${first.granularity}):`, first.repo, first.path, first.symbol);
  console.log('Preview:', first.preview);
}
```

File-level and snippet-level matches are automatically merged and ranked. Inspect `codeResult.topMatch` for the highest-scoring candidate.

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
