/**
 * Guards the `docs/todo/` status convention (see `docs/todo/README.md`).
 *
 * Plan and effort logs are long-lived and world-readable, and a finished plan reads exactly
 * like a live one unless it says otherwise — which is how stale guidance gets followed. Every
 * document therefore carries a status banner, and finished ones live under `done/`. This test
 * makes drift a build failure rather than something review has to catch, mirroring how the
 * i18n catalog rules are enforced.
 *
 * It deliberately asserts only what a machine can know: that the banner exists, uses a known
 * status, and sits in the right folder for that status. Whether "COMPLETE" is *true* is a
 * human call.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);
const TODO_DIR = join(REPO_ROOT, 'docs', 'todo');
const DONE_DIR = join(TODO_DIR, 'done');

/** The canonical statuses, and where a document carrying each one belongs. */
const PLACEMENT = {
  ACTIVE: 'todo',
  REFERENCE: 'todo',
  COMPLETE: 'done',
  SUPERSEDED: 'done',
} as const;

type Status = keyof typeof PLACEMENT;

/**
 * The banner: a blockquote line, an optional leading emoji, then the status word. Anything
 * after the status (a dash and a one-line summary) is free text and not asserted here.
 */
const BANNER = /^> \*\*Status:\*\* (?:\S+\s+)?(ACTIVE|REFERENCE|COMPLETE|SUPERSEDED)\b/m;

/** Every markdown file under `docs/todo/`, tagged with the folder it sits in. */
// `label` is the path relative to the checkout root, so test names and failure messages stay
// readable (and identical between checkouts) now that `path` is absolute. Separators are
// normalised to `/` so a test's *name* does not differ between Windows and CI — `-t` filters
// and any tooling keyed on test names then behave the same everywhere.
function collect(): { path: string; label: string; folder: 'todo' | 'done' }[] {
  const md = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.md'));
  const entry = (dir: string, folder: 'todo' | 'done') =>
    md(dir).map((f) => {
      const path = join(dir, f);
      return { path, label: relative(REPO_ROOT, path).replaceAll(sep, '/'), folder };
    });
  return [...entry(TODO_DIR, 'todo'), ...entry(DONE_DIR, 'done')];
}

const docs = collect();

describe('docs/todo status convention', () => {
  it('finds the plan documents at all (guards against a silently-empty sweep)', () => {
    expect(docs.length).toBeGreaterThan(5);
  });

  it.each(docs)('$label carries a recognised status banner', ({ path, label }) => {
    const banner = BANNER.exec(readFileSync(path, 'utf8'));
    expect(
      banner,
      `${label} has no valid status banner. Add one as the first line ` +
        `after the heading, e.g. "> **Status:** 🟢 ACTIVE — what is next." ` +
        `See docs/todo/README.md.`,
    ).not.toBeNull();
  });

  it.each(docs)('$label sits in the folder its status requires', ({ path, label, folder }) => {
    const status = BANNER.exec(readFileSync(path, 'utf8'))?.[1] as Status | undefined;
    if (!status) return; // The banner test above already reports this file.
    const expected = PLACEMENT[status];
    expect(
      folder,
      `${label} is marked ${status}, which belongs in ` +
        `docs/todo${expected === 'done' ? '/done' : ''}/. Move it (git mv) and update any ` +
        `inbound links. See docs/todo/README.md.`,
    ).toBe(expected);
  });
});
