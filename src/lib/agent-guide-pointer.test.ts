/**
 * Keeps `AGENTS.md` a pointer to `CLAUDE.md`, not a second copy of its rules.
 *
 * `CLAUDE.md` is the only statement of how this repository is worked on, and `AGENTS.md` sends
 * agents that read it instead to that file. `AGENTS.md` used to reproduce some rules and index the
 * rest, which took a parity test to hold the two copies together — and the index still fell a month
 * behind once. With no copy there is nothing to drift, so this test guards only against a copy
 * coming back: a rule section in `AGENTS.md` would start a second definition.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);
const AGENTS = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');

describe('AGENTS.md defers to CLAUDE.md', () => {
  it('links CLAUDE.md, which exists', () => {
    expect(AGENTS).toContain('](CLAUDE.md)');
    expect(existsSync(join(REPO_ROOT, 'CLAUDE.md'))).toBe(true);
  });

  it('states no rule sections of its own', () => {
    const headings = AGENTS.split('\n').filter((line) => /^#{2,} /.test(line));
    expect(headings, 'AGENTS.md is a pointer. Put the rule in CLAUDE.md instead.').toEqual([]);
  });
});
