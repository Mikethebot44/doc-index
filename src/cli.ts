#!/usr/bin/env node

import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { DocIndexSDK } from './index';
import { DocIndexConfig } from './types';

dotenv.config();

const program = new Command();

program
  .name('doc-index')
  .description('Document Indexing SDK - Index and search code and documentation')
  .version('1.0.0');

program
  .command('index-repo')
  .description('Index a GitHub repository')
  .argument('<repo-url>', 'GitHub repository URL (e.g., https://github.com/owner/repo)')
  .option('-b, --branch <branch>', 'Branch to index', 'main')
  .option('--include <paths...>', 'Include paths (e.g., src/)', [])
  .option('--exclude <paths...>', 'Exclude paths (e.g., node_modules/)', [])
  .action(async (repoUrl, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Indexing repository: ${repoUrl}`);
    console.log(`Branch: ${options.branch}`);
    console.log('');
    
    try {
      const resourceId = await sdk.indexRepository(
        repoUrl,
        {
          branch: options.branch,
          includePaths: options.include.length > 0 ? options.include : undefined,
          excludePaths: options.exclude.length > 0 ? options.exclude : undefined,
        },
        (current, total) => {
          console.log(`Progress: ${current}/${total} chunks indexed`);
        }
      );
      
      console.log(`Repository indexed successfully: ${resourceId}`);
    } catch (error) {
      console.error('Failed to index repository:', error);
      process.exit(1);
    }
  });

program
  .command('search-code')
  .description('Search codebase with natural language')
  .argument('<query>', 'Natural language search query')
  .option('-r, --repos <repos...>', 'Limit search to specific repositories', [])
  .option('-l, --limit <limit>', 'Maximum number of results', '10')
  .option('--lang <langs...>', 'Filter by programming language', [])
  .action(async (query, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Searching: "${query}"`);
    console.log('');
    
    try {
      const results = await sdk.searchCodebase(
        query,
        options.repos.length > 0 ? options.repos : undefined,
        {
          limit: parseInt(options.limit),
          filter: {
            language: options.lang.length > 0 ? options.lang : undefined,
          },
        }
      );
      
      console.log(`Found ${results.length} results:`);
      console.log('');
      
      results.forEach((result, i) => {
        console.log(`${i + 1}. ${result.metadata.filePath} (score: ${result.score.toFixed(3)})`);
        console.log(`   Language: ${result.metadata.language || 'unknown'}`);
        console.log(`   Content: ${result.metadata.content.substring(0, 100)}...`);
        console.log('');
      });
    } catch (error) {
      console.error('Failed to search:', error);
      process.exit(1);
    }
  });

program
  .command('index-docs')
  .description('Index documentation from a URL')
  .argument('<url>', 'Documentation URL')
  .option('-m, --max-pages <max>', 'Maximum pages to crawl', '100')
  .action(async (url, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Indexing documentation: ${url}`);
    console.log('');
    
    try {
      const resourceId = await sdk.indexDocumentation(
        url,
        {
          maxPages: parseInt(options.maxPages),
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
  .action(async (query, options) => {
    const config = getConfig();
    const sdk = new DocIndexSDK(config);
    
    console.log(`Searching: "${query}"`);
    console.log('');
    
    try {
      const results = await sdk.searchDocumentation(
        query,
        options.sources.length > 0 ? options.sources : undefined,
        {
          limit: parseInt(options.limit),
        }
      );
      
      console.log(`Found ${results.length} results:`);
      console.log('');
      
      results.forEach((result, i) => {
        console.log(`${i + 1}. ${result.metadata.url} (score: ${result.score.toFixed(3)})`);
        console.log(`   Content: ${result.metadata.content.substring(0, 100)}...`);
        console.log('');
      });
    } catch (error) {
      console.error('Failed to search:', error);
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
  const githubToken = process.env.GITHUB_TOKEN;
  
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
    githubToken,
  };
}

program.parse();

