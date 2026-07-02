/**
 * MCP server entry point: wire snapshot watcher → stdio JSON-RPC server and serve.
 *
 * The runnable composition root, mirroring `serve.ts` (the HTTP entry) but for the Model
 * Context Protocol over stdio. It reuses the *same* hydration and the *same* atomic
 * re-hydrating watcher, so the MCP tools answer from fresh data exactly like the HTTP API.
 * Run it via the `mcp.mjs` bootstrap (which registers the `@/` loader and loads `.env`):
 *
 *   node bridge/mcp.mjs
 *
 * Transport posture: stdio is the local process's own pipe, so there is **no network bearer
 * token** — only `GUBBINS_SNAPSHOT_PATH` is required. Read-only throughout: the tools only
 * ever read through the query core / repositories.
 *
 * IMPORTANT: stdout carries the JSON-RPC protocol; **all logging goes to stderr** so it never
 * corrupts the message stream.
 */
import { loadSnapshotPath, type Env } from '../config.ts';
import { createSnapshotWatcher, type SnapshotWatcher } from '../watcher.ts';
import { runStdioServer, type StdioServer } from './stdio.ts';

export interface RunningMcpServer {
  readonly server: StdioServer;
  readonly watcher: SnapshotWatcher;
}

/** Diagnostic logging — stderr only, never stdout (which is the protocol channel). */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Load config, hydrate the first snapshot, and start serving MCP over stdio. */
export async function startMcpServer(env: Env = process.env): Promise<RunningMcpServer> {
  const snapshotPath = loadSnapshotPath(env);

  const watcher = createSnapshotWatcher({
    snapshotPath,
    onReload: (state) => log(`Snapshot loaded (generated ${state.snapshotGeneratedAt ?? 'unknown'}).`),
    onError: (error) => log(`Snapshot reload failed: ${error.message}`),
  });
  await watcher.start();

  const server = runStdioServer({ getState: () => watcher.getState() });
  log('Gubbins MCP server ready on stdio (read-only).');

  const shutdown = (): void => {
    void watcher.stop();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, watcher };
}

startMcpServer().catch((error: unknown) => {
  log(`MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
