/**
 * Guards the SQLite-glue split (issue #165).
 *
 * `DB_FILENAME` is one string, but it used to live in `db/worker/sqlite-bootstrap.ts` beside a
 * static `@sqlite.org/sqlite-wasm` import. Every main-thread module that wanted the name
 * therefore inherited ~200 KB of emscripten glue it never runs — the main thread only reaches
 * SQLite over worker RPC — which is what bloated the Safe Mode chunk to 212 KB.
 *
 * Two things have to stay true for the split to be worth anything, and neither is visible in
 * review (a stray import costs nothing at type-check time and shows up only in a bundle
 * report), so both are asserted here — the same "make drift a build failure, not a review
 * catch" posture as the storage-key registry and `docs/todo/` banner guards.
 *
 *   1. `db/db-file.ts` stays a leaf — no imports at all, of any form.
 *   2. Only the worker imports `sqlite-bootstrap`. Pinning just the one call site that
 *      regressed would let the *next* main-thread module re-add the weight silently, so the
 *      scan covers all of `src/`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the storage-keys and docs/todo guards).
const SRC_DIR = resolve(process.cwd(), 'src');

/** The worker is the one place that legitimately pulls in SQLite itself. */
const WORKER_DIR = join(SRC_DIR, 'db', 'worker');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Any import of the bootstrap module — static, side-effect-only, or dynamic. */
const BOOTSTRAP_IMPORT = /(?:^\s*import\b[^;]*?|\bimport\s*\(\s*)['"][^'"]*sqlite-bootstrap['"]/ms;

/** Every non-test source file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('DB_FILENAME leaf module', () => {
  it('imports nothing, so importing the name costs nothing', () => {
    const text = readFileSync(join(SRC_DIR, 'db', 'db-file.ts'), 'utf8');
    // Catches `import x from 'y'`, a bare side-effect `import 'y'`, and `import('y')` alike —
    // a side-effect import has no `from` clause, so a `from`-based check would wave it through.
    expect(text).not.toMatch(/^\s*import\b/m);
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/^\s*export\b[^;]*?\bfrom\b/ms);
  });
});

describe('sqlite-bootstrap stays out of the main thread', () => {
  it('is imported only from inside the database worker', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((path) => !path.startsWith(WORKER_DIR))
      .filter((path) => BOOTSTRAP_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(process.cwd(), path));

    // Importing anything from `sqlite-bootstrap` drags the whole WASM glue into that chunk.
    // Need the database filename on the main thread? Import it from `@/db/db-file`.
    expect(offenders).toEqual([]);
  });
});
