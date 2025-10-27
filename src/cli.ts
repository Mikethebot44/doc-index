#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { DocIndexSDK } from './index';
import { DocIndexConfig } from './types';

dotenv.config();

const program = new Command();

program
  .name('doc-index')
  .description('Document Indexing SDK - Index and search documentation sources')
  .version('1.0.0');

program
  .command('index-docs')
  .description('Index documentation from a URL')
  .argument('<url>', 'Documentation URL')
  .argument('[prompt]', 'Specification prompt to guide crawling')
  .option('-m, --max-pages <max>', 'Maximum pages to crawl', '100')
  .option('-p, --prompt <prompt>', 'Specification prompt override')
  .option('-i, --include <paths...>', 'Include only paths (substring match)', [])
  .option('-e, --exclude <paths...>', 'Exclude paths (substring match)', [])
  .action(async (url, promptArg, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Indexing documentation: ${url}`);
    console.log('');
    
    try {
      const parsedLimit = Number.parseInt(options.maxPages, 10);
      const maxPages = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
      const include = Array.isArray(options.include) ? options.include : options.include ? [options.include] : [];
      const exclude = Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [];

      const resourceId = await sdk.indexDocumentation(
        url,
        {
          maxPages,
          prompt: options.prompt ?? promptArg,
          includePaths: include.length > 0 ? include : undefined,
          excludePaths: exclude.length > 0 ? exclude : undefined,
        },
        (current, total) => {
          console.log(`Progress: ${current}/${total} chunks indexed`);
        }
      );
      
      console.log(`Documentation indexed successfully: ${resourceId}`);
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
  .action(async (query, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Searching: "${query}"`);
    console.log('');
    
    try {
      if (options.grouped || options.returnPage) {
        const grouped = await sdk.searchDocumentationGrouped(query, {
          limit: parseInt(options.limit),
          returnPage: Boolean(options.returnPage),
        });
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
          { limit: parseInt(options.limit) }
        );
        console.log(`Found ${results.length} results:`);
        console.log('');
        results.forEach((result, i) => {
          console.log(`${i + 1}. ${result.metadata.url} (score: ${result.score.toFixed(3)})`);
          console.log(`   Content: ${result.metadata.content.substring(0, 100)}...`);
          console.log('');
        });
      }
    } catch (error) {
      console.error('Failed to search:', error);
      process.exit(1);
    }
  });

program
  .command('summarize-docs')
  .description('Summarize top matching documentation pages')
  .argument('<query>', 'Query to summarize against')
  .option('--top <n>', 'Number of top pages', '3')
  .option('--model <model>', 'LLM model to use', 'gpt-5-mini')
  .action(async (query, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    try {
      console.log(`Summarizing top ${options.top} pages with model: ${options.model}`);
      const summary = await sdk.summarizeDocumentation(query, {
        topPages: parseInt(options.top),
        model: options.model,
      });
      console.log(summary);
    } catch (error) {
      console.error('Failed to summarize:', error);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all indexed resources')
  .action(async () => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    try {
      const resources = await sdk.listResources();
      
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
  .description('Check status of a resource')
  .argument('<resource-id>', 'Resource ID')
  .action(async (resourceId) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    try {
      const resource = await sdk.checkResourceStatus(resourceId);
      
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
  };
}

program.parse();
