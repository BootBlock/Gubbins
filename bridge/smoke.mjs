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
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(BRIDGE_DIR, 'src', 'fixtures', 'synthetic-snapshot.json');
const MCP_ENTRY = path.join(BRIDGE_DIR, 'mcp.mjs');
const SERVE_ENTRY = path.join(BRIDGE_DIR, 'serve.mjs');

/**
 * The seeded Admin user's fixed id, mirrored from `src/db/repositories/constants.ts`. This file
 * is plain `.mjs` run without the TypeScript loader, so it cannot import the constant; the value
 * is a stable, well-known baseline id rather than a secret, and the smoke fails loudly if it
 * ever stops resolving.
 */
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000011';

/** A generous per-phase ceiling — a cold Node + hydrate is well under this; a hang trips it. */
const PHASE_TIMEOUT_MS = 30_000;
/** Loopback port for the HTTP boot check (overridable to dodge a local collision). */
const SMOKE_PORT = Number(process.env.GUBBINS_SMOKE_PORT ?? 8799);
/** The HTTP server requires a non-empty bearer value; this loopback-only, ephemeral placeholder
 * satisfies that — it is not a credential (nothing sensitive is ever behind it). */
/**
 * A random token minted for this run only, plus the temporary snapshot carrying its hash.
 *
 * Since issue #79 the bridge authenticates against per-user tokens that live in the database,
 * so the smoke has to seed one rather than pass a shared secret through the environment. The
 * token is generated fresh each run and never written anywhere but a temp file, so nothing
 * credential-shaped is committed — and seeding it this way means the smoke exercises the real
 * identity-resolution path (repository + permission engine) through the strip-only loader,
 * which is precisely what this check exists to catch.
 */
const SMOKE_AUTH = `gbn_${randomBytes(32).toString('hex')}`;
const SMOKE_AUTH_HASH = createHash('sha256').update(SMOKE_AUTH).digest('hex');

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
      if (responses.has(1) && responses.has(2) && responses.has(3) && responses.has(4)) resolve();
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
    // A revision the server does not implement: it must name one it does, not echo this back
    // (issue #568). Sent last so the two handshakes cannot be confused for one another.
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01', capabilities: {} },
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
  if (init?.protocolVersion !== '2024-11-05') {
    fail(`initialize did not agree to the supported revision: ${JSON.stringify(init?.protocolVersion)}`);
  }
  const unsupported = responses.get(4)?.result;
  if (unsupported?.protocolVersion === '2099-01-01' || typeof unsupported?.protocolVersion !== 'string') {
    fail(`initialize echoed an unsupported protocol version: ${JSON.stringify(unsupported)}`);
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
  log(
    `mcp.mjs OK — ${tools.length} tools; gubbins_search matched "${matches[0].name}"; ` +
      `an unsupported revision was answered with ${unsupported.protocolVersion}.`,
  );
}

/**
 * Boot `bridge/serve.mjs` (the HTTP entry — a larger import graph than the MCP one) and poll
 * `/health` until it answers from the fixture. Kills the child before resolving.
 */
async function smokeServe() {
  log('booting serve.mjs (HTTP)…');
  const snapshotPath = await writeSnapshotWithToken();
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      GUBBINS_SNAPSHOT_PATH: snapshotPath,
      GUBBINS_BRIDGE_HOST: '127.0.0.1',
      GUBBINS_BRIDGE_PORT: String(SMOKE_PORT),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const exited = new Promise((_, reject) =>
    child.on('exit', (code) => reject(new Error(`serve.mjs exited early (code ${code})`))),
  );

  try {
    // Wait for the server to be up (and prove the seeded token resolves) before asserting the
    // refusal, so the last request the process makes is the one whose body it fully consumes.
    const health = await Promise.race([pollHealth(), exited, timeout(PHASE_TIMEOUT_MS, 'serve.mjs /health')]);
    await assertUnknownTokenRefused();
    if (health?.ok !== true || typeof health.itemCount !== 'number' || health.itemCount <= 0) {
      fail(`/health returned an unexpected body: ${JSON.stringify(health)}`);
    }
    log(`serve.mjs OK — /health reports itemCount=${health.itemCount}.`);

    // A token that resolves to nobody must be refused, not merely unlucky: this is the one
    // assertion that proves authentication is doing something rather than waving everything past.
  } finally {
    child.kill();
    await rm(snapshotPath, { force: true });
  }
}

/**
 * A token that resolves to nobody must be refused, not merely unlucky: this is the assertion that
 * proves authentication is doing something rather than waving everything past (issue #79).
 */
async function assertUnknownTokenRefused() {
  // Deliberately `node:http` with `agent: false` rather than `fetch`: fetch keeps its socket in a
  // keep-alive pool, and a pooled connection to a server this script is about to kill leaves a
  // live handle at teardown (which aborts the process on Windows rather than exiting cleanly).
  // An un-pooled request opens one socket and closes it.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: SMOKE_PORT,
        path: '/health',
        agent: false,
        headers: { Authorization: 'Bearer gbn_not-a-real-token' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  if (status !== 401) {
    fail(`/health accepted an unknown token (status ${status}); expected 401.`);
  }
  log('serve.mjs OK — an unknown token is refused with 401.');
}

/**
 * Write a copy of the synthetic fixture carrying one `api_tokens` row for {@link SMOKE_AUTH},
 * owned by the built-in Admin, and return its path. Only the hash is stored, exactly as the app
 * stores it — the bridge hashes what a caller presents and looks it up.
 */
async function writeSnapshotWithToken() {
  const snapshot = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const now = Date.now();
  snapshot.tables.api_tokens = [
    {
      id: 'smoke-token',
      user_id: ADMIN_USER_ID,
      name: 'Smoke check',
      token_hash: SMOKE_AUTH_HASH,
      token_prefix: SMOKE_AUTH.slice(0, 10),
      created_at: now,
      updated_at: now,
    },
  ];
  const target = path.join(tmpdir(), `gubbins-smoke-${process.pid}.json`);
  await writeFile(target, JSON.stringify(snapshot), 'utf8');
  return target;
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
