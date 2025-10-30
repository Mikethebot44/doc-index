#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { DocIndexSDK } from './index';
import { DocIndexConfig } from './types';

dotenv.config();

const program = new Command();

const DEFAULT_LOADING_MESSAGES = [
  'Thinking...',
  'Researching...',
  'Gathering documentation...',
  'Crunching embeddings...',
  'Almost there...',
];

const INDEX_LOADING_MESSAGES = [
  'Preparing crawl request...',
  'Contacting Firecrawl...',
  'Processing pages...',
  'Embedding content...',
];

const SEARCH_LOADING_MESSAGES = [
  'Thinking...',
  'Searching the index...',
  'Ranking matches...',
  'Collecting snippets...',
];

const FIND_LOADING_MESSAGES = [
  'Researching...',
  'Exploring the web...',
  'Collecting candidate sources...',
];

const SUMMARIZE_LOADING_MESSAGES = [
  'Thinking...',
  'Reviewing top documents...',
  'Drafting summary...',
];

const AGENT_LOADING_MESSAGES = [
  'Thinking...',
  'Researching documentation...',
  'Consulting tools...',
  'Synthesizing answer...',
];

function startLoading(messages: string[] = DEFAULT_LOADING_MESSAGES, intervalMs = 1200): () => void {
  if (!Array.isArray(messages) || messages.length === 0) {
    return () => {};
  }
  const supportsCursor =
    Boolean(process.stdout?.isTTY) &&
    typeof process.stdout.clearLine === 'function' &&
    typeof process.stdout.cursorTo === 'function';

  if (!supportsCursor) {
    return () => {};
  }

  let index = Math.floor(Math.random() * messages.length);
  let active = true;

  const render = () => {
    if (!active) return;
    const message = messages[index % messages.length];
    index += 1;
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(message);
  };

  render();
  const timer = setInterval(render, intervalMs);

  return () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  };
}

program
  .name('doc-index')
  .description('Document Indexing SDK - Index and search documentation sources')
  .version('1.0.0');

program
  .command('create-namespace')
  .description('Create a new Pinecone namespace for the configured index')
  .argument('<name>', 'Namespace name to create')
  .option('-d, --description <description>', 'Description metadata to associate with the namespace')
  .option('-m, --metadata <json>', 'Additional metadata JSON to store with the namespace placeholder')
  .option('-p, --placeholder-id <id>', 'Custom placeholder vector identifier')
  .action(async (namespaceName, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);

    let parsedMetadata: Record<string, unknown> | undefined;
    if (options.metadata) {
      try {
        const raw = JSON.parse(options.metadata);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsedMetadata = raw as Record<string, unknown>;
        } else {
          throw new Error('Metadata JSON must describe an object');
        }
      } catch (error) {
        console.error('Invalid metadata JSON provided. Ensure it is a valid JSON object.');
        if (error instanceof Error) {
          console.error(error.message);
        }
        process.exit(1);
      }
    }

    try {
      const result = await sdk.createNamespace(namespaceName, {
        description: options.description,
        placeholderId: options.placeholderId,
        metadata: parsedMetadata,
      });

      console.log(result.created ? `Namespace created: ${result.name}` : `Namespace already existed: ${result.name}`);
      console.log(`Placeholder vector ID: ${result.placeholderId}`);

      const metadataEntries = Object.entries(result.metadata ?? {});
      if (metadataEntries.length > 0) {
        console.log('Metadata:');
        metadataEntries.forEach(([key, value]) => {
          let rendered: string;
          if (key === 'createdAt' && typeof value === 'number') {
            rendered = new Date(value).toISOString();
          } else if (typeof value === 'object' && value !== null) {
            try {
              rendered = JSON.stringify(value);
            } catch {
              rendered = String(value);
            }
          } else {
            rendered = String(value);
          }
          console.log(`  ${key}: ${rendered}`);
        });
      }
    } catch (error) {
      console.error('Failed to create namespace:', error);
      process.exit(1);
    }
  });

program
  .command('index-docs')
  .description('Index documentation from a URL')
  .argument('<url>', 'Documentation URL')
  .argument('[prompt]', 'Specification prompt to guide crawling')
  .option('-m, --max-pages <max>', 'Maximum pages to crawl', '100')
  .option('-p, --prompt <prompt>', 'Specification prompt override')
  .option('-i, --include <paths...>', 'Include only paths (substring match)', [])
  .option('-e, --exclude <paths...>', 'Exclude paths (substring match)', [])
  .option('-b, --background', 'Run indexing in the background', false)
  .option('-n, --namespace <name>', 'Pinecone namespace to target', '__default__')
  .action(async (url, promptArg, options) => {
    const config = getConfig();
    const namespace = typeof options.namespace === 'string' && options.namespace.trim().length > 0
      ? options.namespace
      : config.pineconeNamespace ?? '__default__';
    const sdk = new DocIndexSDK({ ...config, pineconeNamespace: namespace });

    console.log(`Indexing documentation: ${url}`);
    console.log('');

    try {
      const parsedLimit = Number.parseInt(options.maxPages, 10);
      const maxPages = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
      const include = Array.isArray(options.include) ? options.include : options.include ? [options.include] : [];
      const exclude = Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [];
      const requestOptions = {
        maxPages,
        prompt: options.prompt ?? promptArg,
        includePaths: include.length > 0 ? include : undefined,
        excludePaths: exclude.length > 0 ? exclude : undefined,
        namespace,
      };

      if (options.background) {
        const job = await sdk.enqueueIndexDocumentation(url, requestOptions);
        console.log(`Queued background indexing job: ${job.id}`);
        console.log(`Resource ID: ${job.resourceId}`);
        console.log('');
        console.log('Track progress with: doc-index status', job.id);
        setImmediate(() => process.exit(0));
        return;
      }

      const stopIndicatorInternal = startLoading(INDEX_LOADING_MESSAGES);
      let spinnerActive = true;
      const stopSpinner = () => {
        if (!spinnerActive) return;
        spinnerActive = false;
        stopIndicatorInternal();
      };

      try {
        const resourceId = await sdk.indexDocumentation(
          url,
          requestOptions,
          (current, total) => {
            stopSpinner();
            console.log(`Progress: ${current}/${total} chunks indexed`);
          },
          (message, level = 'info') => {
            stopSpinner();
            if (level === 'error') {
              console.error(message);
            } else {
              console.log(message);
            }
          }
        );
        
        stopSpinner();
        console.log(`Documentation indexed successfully: ${resourceId}`);
      } catch (error) {
        stopSpinner();
        throw error;
      }
    } catch (error) {
      console.error('Failed to index documentation:', error);
      process.exit(1);
    }
  });

program
  .command('search-docs')
  .description('Search documentation with natural language')
  .argument('<query>', 'Natural language search query')
  .option('-s, --sources <sources...>', 'Limit search to specific sources', [])
  .option('-l, --limit <limit>', 'Maximum number of results', '10')
  .option('--grouped', 'Group results by page URL', false)
  .option('--return-page', 'Return assembled page markdown', false)
  .option('-n, --namespace <name>', 'Pinecone namespace to target', '__default__')
  .action(async (query, options) => {
    const config = getConfig();
    const namespace = typeof options.namespace === 'string' && options.namespace.trim().length > 0
      ? options.namespace
      : config.pineconeNamespace ?? '__default__';
    const sdk = new DocIndexSDK({ ...config, pineconeNamespace: namespace });

    console.log(`Searching: "${query}"`);
    console.log('');
    
    const stopIndicatorInternal = startLoading(SEARCH_LOADING_MESSAGES);
    let spinnerActive = true;
    const stopSpinner = () => {
      if (!spinnerActive) return;
      spinnerActive = false;
      stopIndicatorInternal();
    };

    try {
      if (options.grouped || options.returnPage) {
        const grouped = await sdk.searchDocumentationGrouped(query, {
          limit: parseInt(options.limit),
          returnPage: Boolean(options.returnPage),
          namespace,
        });
        stopSpinner();
        if (options.returnPage) {
          grouped.forEach((page: any, i: number) => {
            console.log(`${i + 1}. ${page.url} (score: ${page.score.toFixed(3)})`);
            console.log(page.page.substring(0, 400));
            console.log('');
          });
        } else {
          grouped.forEach((page: any, i: number) => {
            console.log(`${i + 1}. ${page.url} (score: ${page.score.toFixed(3)})`);
            page.snippets.forEach((s: string, j: number) => {
              console.log(`   - ${j + 1}: ${s.substring(0, 120)}...`);
            });
            console.log('');
          });
        }
      } else {
        const results = await sdk.searchDocumentation(
          query,
          options.sources.length > 0 ? options.sources : undefined,
          { limit: parseInt(options.limit), namespace }
        );
        stopSpinner();
        console.log(`Found ${results.length} results:`);
        console.log('');
        results.forEach((result, i) => {
          console.log(`${i + 1}. ${result.metadata.url} (score: ${result.score.toFixed(3)})`);
          console.log(`   Content: ${result.metadata.content.substring(0, 100)}...`);
          console.log('');
        });
      }
      stopSpinner();
    } catch (error) {
      stopSpinner();
      console.error('Failed to search:', error);
      process.exit(1);
    }
  });

program
  .command('find-docs')
  .description('Find relevant documentation URLs from the web')
  .argument('<query>', 'Search query')
  .option('-l, --limit <limit>', 'Maximum number of results to return', '10')
  .option('--github', 'Include GitHub repositories and discussions', false)
  .option('--research', 'Include research papers and academic sources', false)
  .option('--pdf', 'Include PDF documents when available', false)
  .action(async (query, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);

    console.log(`Finding documents for: "${query}"`);
    console.log('');

    const stopIndicatorInternal = startLoading(FIND_LOADING_MESSAGES);
    let spinnerActive = true;
    const stopSpinner = () => {
      if (!spinnerActive) return;
      spinnerActive = false;
      stopIndicatorInternal();
    };

    try {
      const parsedLimit = Number.parseInt(options.limit, 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
      const results = await sdk.findDocs(query, {
        limit,
        includeGithub: Boolean(options.github),
        includeResearch: Boolean(options.research),
        includePdf: Boolean(options.pdf),
      });
      stopSpinner();

      if (!results.length) {
        console.log('No results found.');
        return;
      }

      results.forEach((result, index) => {
        const title = result.title ?? 'Untitled result';
        console.log(`${index + 1}. ${title}`);
        console.log(`   URL: ${result.url}`);
        if (result.source) {
          console.log(`   Source: ${result.source}`);
        }
        if (typeof result.score === 'number') {
          console.log(`   Score: ${result.score.toFixed(3)}`);
        }
        if (result.description) {
          const snippet = result.description.length > 160
            ? `${result.description.substring(0, 157)}...`
            : result.description;
          console.log(`   Snippet: ${snippet}`);
        }
        console.log('');
      });
    } catch (error) {
      stopSpinner();
      console.error('Failed to find documents:', error);
      process.exit(1);
    }
  });

program
  .command('summarize-docs')
  .description('Summarize top matching documentation pages')
  .argument('<query>', 'Query to summarize against')
  .option('--top <n>', 'Number of top pages', '3')
  .option('--model <model>', 'LLM model to use', 'gpt-5-mini')
  .option('-n, --namespace <name>', 'Pinecone namespace to target', '__default__')
  .action(async (query, options) => {
    const config = getConfig();
    const namespace = typeof options.namespace === 'string' && options.namespace.trim().length > 0
      ? options.namespace
      : config.pineconeNamespace ?? '__default__';
    const sdk = new DocIndexSDK({ ...config, pineconeNamespace: namespace });
    console.log(`Summarizing top ${options.top} pages with model: ${options.model}`);
    const stopIndicatorInternal = startLoading(SUMMARIZE_LOADING_MESSAGES);
    let spinnerActive = true;
    const stopSpinner = () => {
      if (!spinnerActive) return;
      spinnerActive = false;
      stopIndicatorInternal();
    };
    try {
      const summary = await sdk.summarizeDocumentation(query, {
        topPages: parseInt(options.top),
        model: options.model,
        namespace,
      });
      stopSpinner();
      console.log(summary);
    } catch (error) {
      stopSpinner();
      console.error('Failed to summarize:', error);
      process.exit(1);
    }
  });

program
  .command('ask-agent')
  .description('Ask the Doc Index AI agent a question')
  .argument('<question...>', 'Question for the agent')
  .option('--model <model>', 'LLM model to use', 'gpt-5-mini')
  .option('--steps <count>', 'Maximum number of tool round-trips', '4')
  .option('--temperature <value>', 'Sampling temperature for the model', '0.2')
  .option('--include-resources', 'Include the indexed resource list as agent context', false)
  .option('-n, --namespace <name>', 'Pinecone namespace to target', '__default__')
  .action(async (questionWords: string[], options) => {
    const config = getConfig();
    const namespace = typeof options.namespace === 'string' && options.namespace.trim().length > 0
      ? options.namespace
      : config.pineconeNamespace ?? '__default__';
    const sdk = new DocIndexSDK({ ...config, pineconeNamespace: namespace });

    const question = Array.isArray(questionWords) ? questionWords.join(' ') : String(questionWords);
    const steps = Number.parseInt(options.steps, 10);
    const temperature = Number.parseFloat(options.temperature);

    console.log(`Agent question: "${question}"`);
    console.log('');
    const stopIndicatorInternal = startLoading(AGENT_LOADING_MESSAGES, 1500);
    let spinnerActive = true;
    const stopSpinner = () => {
      if (!spinnerActive) return;
      spinnerActive = false;
      stopIndicatorInternal();
    };
    let sawStreamChunk = false;

    try {
      const response = await sdk.askAgent(question, {
        model: options.model,
        maxToolRoundtrips: Number.isFinite(steps) ? steps : undefined,
        temperature: Number.isFinite(temperature) ? temperature : undefined,
        includeResourceList: Boolean(options.includeResources),
        namespace,
        onToken: chunk => {
          if (!chunk) return;
          if (!sawStreamChunk) {
            stopSpinner();
            sawStreamChunk = true;
          }
          process.stdout.write(chunk);
        },
      });
      if (!sawStreamChunk) {
        stopSpinner();
        console.log(response);
      } else {
        stopSpinner();
        if (!response.endsWith('\n')) {
          console.log('');
        }
      }
    } catch (error) {
      stopSpinner();
      console.error('Failed to query the agent:', error);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all indexed resources')
  .option('-n, --namespace <name>', 'Pinecone namespace to target', '__default__')
  .action(async (options) => {
    const config = getConfig();
    const namespace = typeof options.namespace === 'string' && options.namespace.trim().length > 0
      ? options.namespace
      : config.pineconeNamespace ?? '__default__';
    const sdk = new DocIndexSDK({ ...config, pineconeNamespace: namespace });

    try {
      const resources = await sdk.listResources(namespace);

      if (resources.length === 0) {
        console.log('No indexed resources found.');
        return;
      }
      
      console.log(`Found ${resources.length} indexed resources:`);
      console.log('');
      
      resources.forEach(resource => {
        console.log(`ID: ${resource.id}`);
        console.log(`Name: ${resource.name}`);
        console.log(`Type: ${resource.type}`);
        console.log(`Status: ${resource.status}`);
        console.log(`Chunks: ${resource.chunksProcessed}/${resource.totalChunks}`);
        if (resource.error) {
          console.log(`Error: ${resource.error}`);
        }
        console.log('');
      });
    } catch (error) {
      console.error('Failed to list resources:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check status of a resource or background job')
  .argument('<id>', 'Resource ID or job ID')
  .action(async (identifier) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    try {
      const job = await sdk.getIndexJob(identifier);
      if (job) {
        console.log(`Job ID: ${job.id}`);
        console.log(`URL: ${job.url}`);
        console.log(`Status: ${job.status}`);
        console.log(`Progress: ${job.progress.current}/${job.progress.total}`);
        if (job.error) {
          console.log(`Error: ${job.error}`);
        }
        console.log(`Created: ${new Date(job.createdAt).toISOString()}`);
        if (job.startedAt) {
          console.log(`Started: ${new Date(job.startedAt).toISOString()}`);
        }
        if (job.completedAt) {
          console.log(`Completed: ${new Date(job.completedAt).toISOString()}`);
        }
        if (job.resourceId) {
          console.log(`Resource ID: ${job.resourceId}`);
          try {
            const resourceNamespace = typeof job.options?.namespace === 'string'
              ? job.options.namespace
              : undefined;
            const resource = await sdk.checkResourceStatus(job.resourceId, resourceNamespace);
            if (resource) {
              console.log('');
              console.log('Latest resource state:');
              console.log(`   Status: ${resource.status}`);
              console.log(`   Chunks: ${resource.chunksProcessed}/${resource.totalChunks}`);
              console.log(`   Updated: ${new Date(resource.updatedAt).toISOString()}`);
              if (resource.error) {
                console.log(`   Error: ${resource.error}`);
              }
            }
          } catch {
            // Ignore resource lookup failures; job data is primary.
          }
        }
        if (job.logs && job.logs.length > 0) {
          const recentLogs = job.logs.slice(-20);
          console.log('');
          console.log('Logs:');
          recentLogs.forEach(entry => {
            const timestamp = new Date(entry.timestamp).toISOString();
            const level = entry.level.toUpperCase();
            console.log(`   [${timestamp}] ${level} ${entry.message}`);
          });
        }
        return;
      }

      const resource = await sdk.checkResourceStatus(identifier);
      
      if (!resource) {
        console.log('Resource not found.');
        return;
      }
      
      console.log(`Resource: ${resource.name}`);
      console.log(`Type: ${resource.type}`);
      console.log(`Status: ${resource.status}`);
      console.log(`Chunks: ${resource.chunksProcessed}/${resource.totalChunks}`);
      console.log(`Created: ${new Date(resource.createdAt).toISOString()}`);
      console.log(`Updated: ${new Date(resource.updatedAt).toISOString()}`);
      if (resource.error) {
        console.log(`Error: ${resource.error}`);
      }
    } catch (error) {
      console.error('Failed to check status:', error);
      process.exit(1);
    }
  });

program
  .command('rename')
  .description('Rename a resource')
  .argument('<resource-id>', 'Resource ID')
  .argument('<new-name>', 'New name')
  .action(async (resourceId, newName) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    try {
      await sdk.renameResource(resourceId, newName);
      console.log(`Resource renamed to: ${newName}`);
    } catch (error) {
      console.error('Failed to rename resource:', error);
      process.exit(1);
    }
  });

program
  .command('delete')
  .description('Delete a resource')
  .argument('<resource-id>', 'Resource ID')
  .action(async (resourceId) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    try {
      await sdk.deleteResource(resourceId);
      console.log(`Resource deleted: ${resourceId}`);
    } catch (error) {
      console.error('Failed to delete resource:', error);
      process.exit(1);
    }
  });

function getConfig(): DocIndexConfig {
  const openaiKey = process.env.OPENAI_API_KEY;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  const pineconeNamespace = process.env.PINECONE_NAMESPACE || process.env.DOC_INDEX_NAMESPACE;

  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  
  if (!pineconeKey) {
    throw new Error('PINECONE_API_KEY environment variable is required');
  }
  
  return {
    openaiKey,
    pineconeKey,
    firecrawlKey,
    pineconeNamespace,
  };
}

program.parse();
