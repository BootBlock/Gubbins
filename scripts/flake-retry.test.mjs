import { describe, it, expect, vi } from 'vitest';
import {
  COLD_START_FLAKE_SIGNATURE,
  isColdStartFlake,
  runWithRetry,
} from './flake-retry.mjs';

/** Build a fake `runOnce` that returns the supplied results in sequence. */
function sequenceRunner(results) {
  let i = 0;
  return vi.fn(async () => results[Math.min(i++, results.length - 1)]);
}

// The cold-start flake's full output looks roughly like this (trimmed): the run
// exits non-zero, every file reports "no tests", and the TypeError fires during
// environment setup, before any test body runs.
const COLD_START_OUTPUT = `
 RUN  v4.1.9

 ❯ src/db/repositories/ItemRepository.ts (0 test)
 ❯ src/features/export/export-data.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
TypeError: Cannot read properties of undefined (reading 'config')
    at ...

 Test Files  no tests
      Tests  no tests
`;

describe('isColdStartFlake', () => {
  it('retries a non-zero run carrying the cold-start fingerprint', () => {
    expect(isColdStartFlake({ exitCode: 1, output: COLD_START_OUTPUT })).toBe(true);
  });

  it('never retries a clean (exit 0) run, even if the string somehow appears', () => {
    // Defensive: a passing run is authoritative and must never be re-run.
    expect(
      isColdStartFlake({ exitCode: 0, output: COLD_START_FLAKE_SIGNATURE }),
    ).toBe(false);
  });

  it('does NOT retry a genuine test failure (no fingerprint)', () => {
    const realFailure = `
 FAIL  src/db/repositories/ItemRepository.phase26.test.ts
 × per-location checkout returns to source
   → expected 4 to be 5

 Test Files  1 failed (66)
      Tests  1 failed | 658 passed (659)
`;
    expect(isColdStartFlake({ exitCode: 1, output: realFailure })).toBe(false);
  });

  it('does NOT retry a real "no test files found" misconfiguration', () => {
    const noFiles = `
 RUN  v4.1.9
 No test files found, exiting with code 1
`;
    expect(isColdStartFlake({ exitCode: 1, output: noFiles })).toBe(false);
  });

  it('tolerates a non-string output payload without throwing', () => {
    // @ts-expect-error — exercising the runtime guard with a non-string.
    expect(isColdStartFlake({ exitCode: 1, output: undefined })).toBe(false);
  });

  it('exposes the exact fingerprint string', () => {
    expect(COLD_START_FLAKE_SIGNATURE).toBe(
      "Cannot read properties of undefined (reading 'config')",
    );
  });
});

const FLAKE = { exitCode: 1, output: `…\n${COLD_START_FLAKE_SIGNATURE}\n…` };
const PASS = { exitCode: 0, output: 'Tests  665 passed (665)' };
const REAL_FAILURE = { exitCode: 1, output: '1 failed | 664 passed' };

describe('runWithRetry', () => {
  it('runs once and returns 0 on a clean pass', async () => {
    const runOnce = sequenceRunner([PASS]);
    const onRetry = vi.fn();
    expect(await runWithRetry({ runOnce, onRetry })).toBe(0);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('re-runs once after a cold-start flake, then returns 0', async () => {
    const runOnce = sequenceRunner([FLAKE, PASS]);
    const onRetry = vi.fn();
    expect(await runWithRetry({ runOnce, onRetry })).toBe(0);
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(2);
  });

  it('does NOT retry a real failure — returns its exit code on the first run', async () => {
    const runOnce = sequenceRunner([REAL_FAILURE, PASS]);
    const onRetry = vi.fn();
    expect(await runWithRetry({ runOnce, onRetry })).toBe(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('surfaces a second consecutive flake honestly rather than looping forever', async () => {
    const runOnce = sequenceRunner([FLAKE, FLAKE]);
    expect(await runWithRetry({ runOnce, maxAttempts: 2 })).toBe(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
