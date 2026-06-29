#!/usr/bin/env node
// Unit-test entry point (`npm run test:run`).
//
// Wraps `vitest run` with a single, *surgical* automatic re-run of the known
// Node-25 cold-start flake. On a genuinely cold cache, Node 25 can make Vitest's
// environment setup stall (~30 s) and then collapse the whole run — every file
// reports "no tests" and the process dies with
//   TypeError: Cannot read properties of undefined (reading 'config')
// before any test body executes. Phase 21's `test.pool: 'threads'` pin made this
// rare but not impossible, and Vitest's own `test.retry` cannot recover it (that
// only re-runs an individual *failing test*, never a run that collapsed with zero
// tests). This wrapper automates the documented "re-run once" mitigation, but
// ONLY when the output carries the exact cold-start fingerprint
// (`isColdStartFlake`), so a real test failure still fails fast and is never
// masked. CLI args are forwarded verbatim (e.g. `npm run test:run -- --reporter=dot`).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWithRetry } from './flake-retry.mjs';

const MAX_ATTEMPTS = 2;

const require = createRequire(import.meta.url);
// Resolve Vitest's CLI entry robustly via its package.json (the package's
// `exports` map does not necessarily expose `vitest/vitest.mjs` as a subpath).
const vitestCli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

/**
 * Run `vitest run <args>` once, streaming its output live to this process's
 * stdio while also capturing it so the cold-start fingerprint can be inspected.
 *
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
function runVitestOnce(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, 'run', ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let output = '';
    const tee = (stream, sink) => {
      stream.on('data', (chunk) => {
        sink.write(chunk);
        output += chunk.toString();
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);

    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

async function main() {
  const args = process.argv.slice(2);

  const exitCode = await runWithRetry({
    runOnce: () => runVitestOnce(args),
    maxAttempts: MAX_ATTEMPTS,
    onRetry: (attempt) =>
      console.warn(
        `\n[test:run] Detected the known Node-25 cold-start flake ` +
          `(environment setup collapsed with "reading 'config'"). ` +
          `Re-running once — attempt ${attempt}/${MAX_ATTEMPTS}.\n`,
      ),
  });

  // exit 0 → clean; otherwise a real failure (or a second consecutive flake),
  // surfaced honestly so genuine failures are never masked.
  process.exit(exitCode);
}

// Only orchestrate when invoked directly, never when imported (e.g. by a test).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
