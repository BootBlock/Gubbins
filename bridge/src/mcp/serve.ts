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
 * token** — only `GUBBINS_SNAPSHOT_PATH` is required. Read-only by default: the tools only ever
 * read through the query core / repositories.
 *
 * Writes are an opt-in the operator must set deliberately (`GUBBINS_BRIDGE_ALLOW_WRITES=on`, the
 * *same* flag the HTTP endpoints use), and are likewise refused for a raw `.sqlite` source, which
 * has no sync channel to round-trip through. Because stdio carries no bearer token, the trust
 * boundary here is **process launch**: anything able to start this server under that flag can
 * adjust stock. That is why the tools are only constructed when the flag is on — off, they are
 * absent from `tools/list` and uncallable — and why enabling it is logged loudly at startup.
 *
 * IMPORTANT: stdout carries the JSON-RPC protocol; **all logging goes to stderr** so it never
 * corrupts the message stream.
 */
import { loadAllowWrites, loadSnapshotPath, loadStaleAfterFailures, type Env } from '../config.ts';
import { createSnapshotWatcher, type SnapshotWatcher } from '../watcher.ts';
import { summarizeSnapshotHealth } from '../snapshot-health.ts';
import { detectSource, writesEnabledForSource } from '../sqlite-source.ts';
import { createWriteExecutor } from '../write.ts';
import { SYSTEM_USER_ID } from '@/db/repositories/constants';
import { errorDetail } from '../errors.ts';
import { ALL_TOOLS, createWriteTools } from './tools.ts';
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
  const allowWrites = loadAllowWrites(env);
  const staleAfterFailures = loadStaleAfterFailures(env);

  const watcher = createSnapshotWatcher({
    snapshotPath,
    onReload: (state) => log(`Snapshot loaded (generated ${state.snapshotGeneratedAt ?? 'unknown'}).`),
    onError: (error) => log(`Snapshot reload failed: ${error.message}`),
  });
  await watcher.start();

  // The write tools exist only under the opt-in *and* a JSON snapshot source; otherwise they are
  // never built, so the tool list stays read-only and nothing can mutate the inventory.
  const source = await detectSource(snapshotPath);
  const writesEnabled = writesEnabledForSource(allowWrites, source);
  // stdio carries no credential, so there is no user to attribute an MCP write to (issue #79):
  // anyone who can launch this process already has the snapshot. Writes are therefore recorded
  // against the System user — the actor the app itself writes as — which is stated here once
  // rather than being a silent default inside the write path.
  const writeExecutor = createWriteExecutor(snapshotPath);
  const tools = writesEnabled
    ? [...ALL_TOOLS, ...createWriteTools((op) => writeExecutor(op, SYSTEM_USER_ID))]
    : ALL_TOOLS;

  const server = runStdioServer({
    getState: () => watcher.getState(),
    // The MCP analogue of `/health`'s honesty (issue #394): a failed re-hydrate keeps the last good
    // snapshot live, so this lets a stale tool result be caveated rather than presented as current.
    getSnapshotHealth: () => summarizeSnapshotHealth(watcher.getReloadHealth(), staleAfterFailures),
    // An unexpected tool failure tells the model only "the tool failed to run" (issue #568), so
    // the reason goes here — stderr, the same channel every other diagnostic uses.
    logError: log,
    tools,
  });
  log(`Gubbins MCP server ready on stdio (${writesEnabled ? 'reads + limited writes' : 'read-only'}).`);
  if (writesEnabled) {
    log(
      'Writes ENABLED (GUBBINS_BRIDGE_ALLOW_WRITES=on): the gubbins_adjust_quantity, ' +
        'gubbins_adjust_gauge, gubbins_check_out, gubbins_check_in and gubbins_transfer_stock tools ' +
        'can mutate the snapshot. stdio carries no bearer token, so any agent that can launch this ' +
        'server can adjust stock and lend items out. Each write round-trips through the sync merge.',
    );
  } else if (allowWrites && source === 'sqlite') {
    log(
      'Writes requested but REFUSED: a raw .sqlite source has no sync channel to round-trip ' +
        'through, so writes would drift. Use a JSON sync snapshot to enable writes. (Read-only.)',
    );
  }

  const shutdown = (): void => {
    void watcher.stop();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, watcher };
}

startMcpServer().catch((error: unknown) => {
  log(`MCP server failed to start: ${errorDetail(error)}`);
  process.exitCode = 1;
});
