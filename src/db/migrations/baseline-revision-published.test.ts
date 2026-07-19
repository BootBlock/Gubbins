/**
 * The update banner promises a user their data survives a reload. Issue #274: that promise used
 * to rest on package.json's hand-maintained `schemaVersion` counter, while the gate boot actually
 * enforces is the *derived* {@link BASELINE_REVISION} — so folding a schema change into the
 * baseline (the documented practice) moved the real gate and left the counter behind, and every
 * installed user was told "your data stays intact" on the way to a reset screen.
 *
 * These tests tie the published value to the derived one, which is the link that was missing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_REVISION } from './v1-initial';
import { repoPath } from '../../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);

describe('published baseline revision (issue #274)', () => {
  it('scripts/baseline-revision.mjs prints the baseline fingerprint the app enforces', () => {
    // This script's output IS the `baselineRevision` the build writes into version.json, so an
    // equality here means the deployed manifest cannot drift from the gate at boot.
    const script = join(REPO_ROOT, 'scripts', 'baseline-revision.mjs');
    const printed = execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim();
    expect(printed).toBe(BASELINE_REVISION);
  });

  it('the build writes that fingerprint into version.json', () => {
    // A wiring guard: the emission itself only happens in a real `vite build`, but silently
    // dropping the field would return the banner to promising safety it never checked. Matched
    // loosely (the key, not a particular helper name) so a refactor of the config doesn't fail
    // a build that still publishes the field.
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/baselineRevision:/);
  });
});
