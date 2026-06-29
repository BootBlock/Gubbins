/**
 * Bare-Node bootstrap for the read-only MCP (Model Context Protocol) server.
 *
 * Like `serve.mjs`, it registers the `@/`-alias resolve hook (loader.mjs) before importing
 * any TypeScript that uses the alias, then loads the git-ignored `.env` (snapshot path), and
 * finally imports the real MCP entry point. The server speaks JSON-RPC over stdio, so an
 * LLM/agent (e.g. Claude) can query the Gubbins inventory as a tool:
 *
 *   node bridge/mcp.mjs
 *
 * `.env` is optional — if it is absent, configuration is read from the real process
 * environment instead (e.g. the MCP client's `env` block), so nothing secret need touch disk.
 * Only GUBBINS_SNAPSHOT_PATH is required; the stdio transport carries no network token.
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

try {
  process.loadEnvFile('.env');
} catch {
  // No .env present: fall back to the ambient process environment.
}

await import('./src/mcp/serve.ts');
