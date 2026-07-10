/**
 * Boot-smoke for the bridge's two runnable entry points, run under **real Node** (not Vitest).
 *
 * Why this exists: the bridge runs the app's own `.ts` directly under Node's built-in
 * *strip-only* TypeScript loader (see `loader.mjs`) — no build step. Strip-only mode rejects
 * constructs that need code generation (constructor **parameter properties**, `enum`,
 * `namespace`). CI's `type-check:bridge` (`tsc --noEmit`) accepts all of those — they are valid
 * TypeScript — and the Vitest suite transpiles via esbuild (a full transform), so **neither ever
 * exercises the strip-only loader**. A violation therefore ships green and only surfaces when the
 * bridge is actually launched (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import time). This smoke
 * closes that gap: it boots each entry point exactly as a user would and asserts a real response,
 * so any strip-only-incompatible syntax anywhere in the bridge's import graph fails CI.
 *
 * It is dependency-free (stdlib only, like the rest of the bridge) and self-contained: it spins
 * up the servers against the committed synthetic fixture, checks them, and tears them down.
 *
 *   node bridge/smoke.mjs
 *
 * Exits 0 on success; on failure it prints a clear message to stderr and exits 1.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(BRIDGE_DIR, 'src', 'fixtures', 'synthetic-snapshot.json');
const MCP_ENTRY = path.join(BRIDGE_DIR, 'mcp.mjs');
const SERVE_ENTRY = path.join(BRIDGE_DIR, 'serve.mjs');

/** A generous per-phase ceiling — a cold Node + hydrate is well under this; a hang trips it. */
const PHASE_TIMEOUT_MS = 30_000;
/** Loopback port for the HTTP boot check (overridable to dodge a local collision). */
const SMOKE_PORT = Number(process.env.GUBBINS_SMOKE_PORT ?? 8799);
/** The HTTP server requires a non-empty bearer value; this loopback-only, ephemeral placeholder
 * satisfies that — it is not a credential (nothing sensitive is ever behind it). */
const SMOKE_AUTH = 'loopback-smoke-check';

const log = (msg) => process.stdout.write(`[bridge-smoke] ${msg}\n`);

/** Fail the whole smoke with a clear, single-line reason. */
function fail(reason) {
  process.stderr.write(`[bridge-smoke] FAIL: ${reason}\n`);
  process.exit(1);
}

/** Reject after `ms`, so a wedged child can never hang CI. */
function timeout(ms, label) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
    t.unref?.();
  });
}

/**
 * Boot `bridge/mcp.mjs`, drive the JSON-RPC handshake over stdio, and assert the read-only
 * tool surface answers from the fixture. Kills the child before resolving.
 */
async function smokeMcp() {
  log('booting mcp.mjs (stdio JSON-RPC)…');
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, GUBBINS_SNAPSHOT_PATH: FIXTURE },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const responses = new Map();
  const rl = createInterface({ input: child.stdout });

  const gotAll = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`mcp.mjs exited early (code ${code})`)));
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // ignore any non-JSON noise on stdout
      }
      if (msg.id != null) responses.set(msg.id, msg);
      if (responses.has(1) && responses.has(2) && responses.has(3)) resolve();
    });
  });

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'esp32' } },
    },
  ];
  child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');

  try {
    await Promise.race([gotAll, timeout(PHASE_TIMEOUT_MS, 'mcp.mjs responses')]);
  } finally {
    rl.close();
    child.kill();
  }

  const init = responses.get(1)?.result;
  if (init?.serverInfo?.name !== 'gubbins-bridge-mcp') {
    fail(`initialize returned unexpected serverInfo: ${JSON.stringify(init?.serverInfo)}`);
  }
  const tools = responses.get(2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 6) {
    fail(`tools/list returned ${Array.isArray(tools) ? tools.length : 'no'} tools (expected >= 6)`);
  }
  const search = responses.get(3)?.result;
  const matches = search?.structuredContent?.matches;
  if (search?.isError !== false || !Array.isArray(matches) || matches.length === 0) {
    fail(`gubbins_search over the fixture returned no matches (${JSON.stringify(search)?.slice(0, 200)})`);
  }
  log(`mcp.mjs OK — ${tools.length} tools; gubbins_search matched "${matches[0].name}".`);
}

/**
 * Boot `bridge/serve.mjs` (the HTTP entry — a larger import graph than the MCP one) and poll
 * `/health` until it answers from the fixture. Kills the child before resolving.
 */
async function smokeServe() {
  log('booting serve.mjs (HTTP)…');
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      GUBBINS_SNAPSHOT_PATH: FIXTURE,
      GUBBINS_BRIDGE_TOKEN: SMOKE_AUTH,
      GUBBINS_BRIDGE_HOST: '127.0.0.1',
      GUBBINS_BRIDGE_PORT: String(SMOKE_PORT),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const exited = new Promise((_, reject) =>
    child.on('exit', (code) => reject(new Error(`serve.mjs exited early (code ${code})`))),
  );

  try {
    const health = await Promise.race([pollHealth(), exited, timeout(PHASE_TIMEOUT_MS, 'serve.mjs /health')]);
    if (health?.ok !== true || typeof health.itemCount !== 'number' || health.itemCount <= 0) {
      fail(`/health returned an unexpected body: ${JSON.stringify(health)}`);
    }
    log(`serve.mjs OK — /health reports itemCount=${health.itemCount}.`);
  } finally {
    child.kill();
  }
}

/** Poll the loopback `/health` endpoint until it returns 200, with the bearer token. */
async function pollHealth() {
  const url = `http://127.0.0.1:${SMOKE_PORT}/health`;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${SMOKE_AUTH}` } });
      if (res.ok) return res.json();
    } catch {
      // Not listening yet — retry.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

try {
  await smokeMcp();
  await smokeServe();
  log('all boot-smoke checks passed.');
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
