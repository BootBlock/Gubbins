/**
 * Tests for the startup Node-version guard (`../node-version.mjs`).
 *
 * The guard exists because the bridge imports TypeScript directly, so a Node without
 * type-stripping dies on a type annotation rather than saying it is too old (issue #256).
 * Its decision is pure and injectable, which is the only way to exercise the whole table —
 * a test run pins exactly one real `process.version`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_NODE_RANGE, checkNodeVersion } from '../node-version.mjs';

/** Node reports `'strip'` here once type-stripping is on; `false` when it is not. */
const STRIPS = 'strip';

/**
 * The runtimes the guard has to judge, and whether it should let each one through.
 *
 * `typescript` is what `process.features.typescript` reports on that build with no extra
 * flags: unflagged from v22.18.0 and v24.0.0, and absent entirely before v22.10.
 */
const CASES: ReadonlyArray<{
  version: string;
  typescript: string | false | undefined;
  allowed: boolean;
  because: string;
}> = [
  { version: 'v20.19.0', typescript: undefined, allowed: false, because: 'no FTS5, no stripping' },
  { version: 'v22.15.1', typescript: false, allowed: false, because: 'below the FTS5 floor' },
  { version: 'v22.16.0', typescript: false, allowed: false, because: 'stripping still flagged' },
  { version: 'v22.17.1', typescript: false, allowed: false, because: 'stripping still flagged' },
  { version: 'v22.18.0', typescript: STRIPS, allowed: true, because: 'the self-sufficient floor' },
  { version: 'v22.22.0', typescript: STRIPS, allowed: true, because: 'above the floor' },
  { version: 'v23.5.0', typescript: false, allowed: false, because: 'the v23.x line has no FTS5' },
  { version: 'v23.6.0', typescript: STRIPS, allowed: false, because: 'strips, but still no FTS5' },
  { version: 'v23.11.1', typescript: STRIPS, allowed: false, because: 'strips, but still no FTS5' },
  { version: 'v24.0.0', typescript: STRIPS, allowed: true, because: 'FTS5 and stripping both in' },
  { version: 'v25.2.1', typescript: STRIPS, allowed: true, because: 'current dev toolchain' },
];

describe('checkNodeVersion', () => {
  for (const { version, typescript, allowed, because } of CASES) {
    it(`${allowed ? 'accepts' : 'rejects'} ${version} — ${because}`, () => {
      const problem = checkNodeVersion({ version, typescript });
      if (allowed) {
        expect(problem).toBeNull();
      } else {
        expect(problem).toBeTypeOf('string');
        // Whatever the reason, the message has to name the Node in front of the user —
        // the failure it replaces gave them no version at all.
        expect(problem).toContain(version);
      }
    });
  }

  it('names the v23.x FTS5 gap rather than suggesting a newer v23', () => {
    const problem = checkNodeVersion({ version: 'v23.6.0', typescript: STRIPS });
    expect(problem).toContain('v23.x');
    expect(problem).toContain('fts5');
  });

  it('points at the flag when only type-stripping is missing', () => {
    const problem = checkNodeVersion({ version: 'v22.17.1', typescript: false });
    expect(problem).toContain('--experimental-strip-types');
  });

  it('does not offer the flag when the build also lacks FTS5', () => {
    const problem = checkNodeVersion({ version: 'v22.15.1', typescript: false });
    expect(problem).not.toContain('--experimental-strip-types');
  });

  it('lets an older v22 through when the user has supplied the flag themselves', () => {
    // The README documents this fallback, so the guard must not be stricter than `engines`
    // in a way that breaks it: v22.16/v22.17 have FTS5, and the flag supplies the rest.
    expect(checkNodeVersion({ version: 'v22.16.0', typescript: STRIPS })).toBeNull();
    expect(checkNodeVersion({ version: 'v22.17.1', typescript: STRIPS })).toBeNull();
  });

  it('stays out of the way when the version string is unrecognisable', () => {
    // A build that does not report a `vMAJOR.MINOR.PATCH` version is not evidence of
    // anything; refusing to start would be worse than letting the real import decide.
    expect(checkNodeVersion({ version: 'not-a-version', typescript: STRIPS })).toBeNull();
    expect(checkNodeVersion({ version: '', typescript: false })).toBeNull();
  });

  it('agrees with the Node this test is running on', () => {
    // CI and local dev both run a supported Node, so the guard must not reject its own
    // host — a guard that fires on every developer machine would just be disabled.
    expect(checkNodeVersion()).toBeNull();
  });
});

describe('SUPPORTED_NODE_RANGE', () => {
  it("matches bridge/package.json's engines.node", () => {
    // Drift guard: the guard's messages quote this range, so a floor raised in one place
    // and not the other would advertise a version the other half does not enforce.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(manifest.engines?.node).toBe(SUPPORTED_NODE_RANGE);
  });
});
