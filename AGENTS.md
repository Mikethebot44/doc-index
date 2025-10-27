# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` centralizes the SDK surface, wiring OpenAI, Pinecone, and Firecrawl integrations.
- `src/cli.ts` exposes the CLI entry point; the `index-docs` command now supports Firecrawl prompts plus include/exclude path filters.
- `src/chunking.ts` performs semantic sentence-aware chunking for documentation before indexing.
- `src/firecrawl.ts`, `src/pinecone.ts`, and `src/openai.ts` wrap external services; keep authentication logic isolated here.
- `src/search.ts` handles Pinecone queries for flat and grouped documentation searches.
- `src/utils/` hosts shared helpers such as retry logic; extend utilities here when adding cross-cutting behavior.
- `dist/` contains TypeScript build artifacts produced by tsup; never edit generated files directly.

## Build, Test, and Development Commands

> ⚠️ **Note:** This repository environment does **not** have network access, so you should **not** attempt to run, build, or install dependencies (e.g., do not use `npm install`, `npm run build`, or similar commands). All development, installation, and build instructions are for reference only and should be performed in an environment with proper network connectivity.

- `npm install` restores dependencies; rerun after updating `package.json`.
- `npm run build` bundles the SDK and CLI with tsup, emitting ESM, CJS, and type definitions into `dist/`.
- `npm run dev` runs tsup in watch mode for iterative development; it rebuilds on file changes.
- `npx tsc --noEmit` performs a strict type check before committing changes.


## Coding Style & Naming Conventions
- TypeScript files use 2-space indentation, single quotes, and explicit type exports (see `src/index.ts` for reference).
- Use `PascalCase` for classes (`DocIndexSDK`), `camelCase` for functions and variables, and `UPPER_SNAKE_CASE` for constants and environment keys.
- Keep external API keys and URLs configurable via environment variables; avoid hardcoding secrets.
- Prefer small, composable modules—new integrations should mirror the pattern in `src/pinecone.ts`.

## Testing Guidelines
- No automated tests exist yet; introduce edge-focused unit tests before significant refactors.
- Place new tests under a `tests/` directory or `src/__tests__/`, naming files `<feature>.spec.ts`.
- When adding a test runner (Vitest or Jest), wire `npm test` to execute it and document required environment fixtures.
- Validate builds (`npm run build`) and type checks (`npx tsc --noEmit`) prior to opening pull requests.

## Commit & Pull Request Guidelines
- Write concise, imperative commit messages (e.g., `feat: add pinecone namespace filter`) and scope large changes into logical units.
- Reference related issues in commit trailers or PR descriptions when applicable.
- Pull requests should summarize intent, list notable changes, and highlight required API keys or config updates.
- Include CLI output or logs when demonstrating new commands, and confirm that `dist/` artifacts remain generated rather than hand-edited.

## Security & Configuration Tips
- Load secrets through `.env` files or deployment-specific configuration; never commit credentials.
- Document any new environment variables in `README.md` and ensure CLI defaults remain safe for public use.
