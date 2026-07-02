// Pure decision logic for the unit-test runner's automatic single re-run of the
// known Node-25 cold-start flake (see scripts/run-unit-tests.mjs).
//
// Background: on Node 25 a genuinely cold cache can make Vitest's environment
// setup stall (~30 s) and then collapse the WHOLE run — every file reports "no
// tests" and the process exits non-zero with
//   TypeError: Cannot read properties of undefined (reading 'config')
// This happens BEFORE any test body runs, so Vitest's own `test.retry` (which
// only re-runs an individual *failing test*) can never recover it. Phase 21
// pinned `test.pool: 'threads'`, which made the flake rare but did not eliminate
// it. The documented mitigation has been "re-run once" — this module encodes the
// precise fingerprint so the re-run can be automated without ever masking a real
// failure.

/**
 * The exact fingerprint the cold-start flake leaves in Vitest's output. Matching
 * the specific TypeError (rather than a vague "no tests" / non-zero exit) keeps
 * the automatic re-run surgical: a genuine test failure or a real "no test files
 * found" misconfiguration does NOT carry this string and so is never retried.
 */
export const COLD_START_FLAKE_SIGNATURE = "Cannot read properties of undefined (reading 'config')";

/**
 * Decide whether a finished `vitest run` should be re-run once because it hit the
 * known Node-25 cold-start flake rather than a real failure.
 *
 * @param {{ exitCode: number, output: string }} result
 * @returns {boolean} true only for a non-zero run whose output carries the
 *   cold-start fingerprint.
 */
export function isColdStartFlake({ exitCode, output }) {
  if (exitCode === 0) return false;
  if (typeof output !== 'string') return false;
  return output.includes(COLD_START_FLAKE_SIGNATURE);
}

/**
 * Orchestrate up to `maxAttempts` runs, re-running ONLY when the previous run was
 * the cold-start flake. A clean run (exit 0) or a real failure returns
 * immediately; a flake is re-run once more (until attempts are exhausted). The
 * actual runner is injected (`runOnce`) so this orchestration is unit-testable
 * without spawning Vitest — and so it never calls `process.exit` itself.
 *
 * @param {object} deps
 * @param {() => Promise<{ exitCode: number, output: string }>} deps.runOnce
 *   Runs the test command once and resolves with its exit code + captured output.
 * @param {number} [deps.maxAttempts] Total attempts allowed (default 2).
 * @param {(attempt: number) => void} [deps.onRetry] Called with the upcoming
 *   attempt number just before a flake re-run (for logging).
 * @returns {Promise<number>} the exit code of the last attempt that ran.
 */
export async function runWithRetry({ runOnce, maxAttempts = 2, onRetry }) {
  let lastExitCode = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runOnce();
    lastExitCode = result.exitCode;

    if (result.exitCode === 0) return 0;

    if (attempt < maxAttempts && isColdStartFlake(result)) {
      onRetry?.(attempt + 1);
      continue;
    }

    return result.exitCode;
  }

  return lastExitCode;
}
