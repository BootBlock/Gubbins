/**
 * Guards against naming a DOM test environment the app's unit suite does not run on (issue #1568).
 *
 * The suite runs on happy-dom. jsdom has never been a dependency, yet thirty files named it, and the
 * wrong model did not stay in the comments: they said `elementFromPoint`, `PointerEvent` and
 * `matchMedia` were missing (happy-dom has all three), and code was written to suit — a guard in
 * `useBoardPointerDrag` that could never fire, and pointer events assembled from a bare `Event` in
 * three drag tests. Nothing about a comment fails a type-check or a component test, so this scan
 * makes it a build failure.
 *
 * The environment in use is read from `vite.config.ts` rather than restated here. Moving the suite
 * to the other environment therefore fails every mention of the old one, which is right: each of
 * those sentences stops being true on the same day.
 *
 * The sweep is every file git tracks or would track, so a new file fails before its first commit.
 * Only files that can carry prose are read; JSON carries none, which also keeps out
 * `package-lock.json`, where jsdom is an optional peer of Vitest. `docs/todo/done/` is left out too:
 * a finished plan records what was true when it was written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);

/** Vitest's two DOM environments. */
const DOM_ENVIRONMENTS = ['happy-dom', 'jsdom'];

/** This guard, which names both environments by design. */
const SELF = relative(REPO_ROOT, join(import.meta.dirname, 'test-environment-name.test.ts')).replaceAll(
  sep,
  '/',
);

/** Files that still name another environment, each with the open issue that corrects it. */
const PENDING = new Map([['src/test/segment-layout.ts', '#781']]);

/** Files that can carry prose: code, styles, markup, docs and scripts. */
const PROSE_FILE = /\.(?:[cm]?[jt]sx?|css|html|md|ya?ml|sh|ps1|bat)$/;

/** Every `environment: '…'` in `vite.config.ts` — the one place the suite's environment is chosen. */
function configuredEnvironments(): string[] {
  const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
  return [...config.matchAll(/^\s*environment:\s*'([^']+)'/gm)].map((match) => match[1]);
}

/** Every file in the checkout that git tracks or would track, as `/`-separated repository paths. */
function repositoryFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // `--cached` still lists a tracked file deleted from the working tree, so keep only what exists.
  return listing.split('\0').filter((path) => path !== '' && existsSync(join(REPO_ROOT, path)));
}

/** The lines of `path` that name any of `names`, as `path:line: text`. */
function mentions(path: string, names: readonly string[]): string[] {
  const pattern = new RegExp(`\\b(?:${names.map((name) => name.replace(/[-]/g, '\\-')).join('|')})\\b`, 'i');
  return readFileSync(join(REPO_ROOT, path), 'utf8')
    .split(/\r?\n/)
    .flatMap((text, index) => (pattern.test(text) ? [`${path}:${index + 1}: ${text.trim()}`] : []));
}

describe('test environment naming (issue #1568)', () => {
  const environments = configuredEnvironments();
  const configured = environments[0];
  const others = DOM_ENVIRONMENTS.filter((name) => name !== configured);
  const files = repositoryFiles();

  it('reads exactly one DOM environment from vite.config.ts', () => {
    expect(environments).toHaveLength(1);
    expect(DOM_ENVIRONMENTS).toContain(configured);
  });

  it('sweeps the repository at all (guards against a silently-empty listing)', () => {
    expect(files).toContain('vite.config.ts');
    expect(files).toContain(SELF);
  });

  it('names no DOM environment but the configured one', () => {
    const offenders = files
      .filter((path) => PROSE_FILE.test(path))
      .filter((path) => path !== SELF && !PENDING.has(path) && !path.startsWith('docs/todo/done/'))
      .flatMap((path) => mentions(path, others));
    expect(
      offenders,
      `These lines name ${others.join(' or ')}, but the unit suite runs on ${configured}. Describe ` +
        `${configured} instead, and check that any API a line calls missing really is.`,
    ).toEqual([]);
  });

  it.each([...PENDING])('%s still names another environment until %s corrects it', (path, issue) => {
    expect(
      mentions(path, others),
      `${path} no longer names ${others.join(' or ')}: ${issue} has corrected it, so remove its PENDING entry.`,
    ).not.toEqual([]);
  });
});
