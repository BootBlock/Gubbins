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
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the extension-manifest guard).
const TODO_DIR = resolve(process.cwd(), 'docs/todo');
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
function collect(): { path: string; folder: 'todo' | 'done' }[] {
  const md = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.md'));
  return [
    ...md(TODO_DIR).map((f) => ({ path: join(TODO_DIR, f), folder: 'todo' as const })),
    ...md(DONE_DIR).map((f) => ({ path: join(DONE_DIR, f), folder: 'done' as const })),
  ];
}

const docs = collect();

describe('docs/todo status convention', () => {
  it('finds the plan documents at all (guards against a silently-empty sweep)', () => {
    expect(docs.length).toBeGreaterThan(5);
  });

  it.each(docs)('$path carries a recognised status banner', ({ path }) => {
    const banner = BANNER.exec(readFileSync(path, 'utf8'));
    expect(
      banner,
      `${relative(process.cwd(), path)} has no valid status banner. Add one as the first line ` +
        `after the heading, e.g. "> **Status:** 🟢 ACTIVE — what is next." ` +
        `See docs/todo/README.md.`,
    ).not.toBeNull();
  });

  it.each(docs)('$path sits in the folder its status requires', ({ path, folder }) => {
    const status = BANNER.exec(readFileSync(path, 'utf8'))?.[1] as Status | undefined;
    if (!status) return; // The banner test above already reports this file.
    const expected = PLACEMENT[status];
    expect(
      folder,
      `${relative(process.cwd(), path)} is marked ${status}, which belongs in ` +
        `docs/todo${expected === 'done' ? '/done' : ''}/. Move it (git mv) and update any ` +
        `inbound links. See docs/todo/README.md.`,
    ).toBe(expected);
  });
});
