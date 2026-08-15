/**
 * Guards the error-copy seam against the idiom it exists to replace (issues #311, #681).
 *
 * `useErrorMessage` was introduced because `error instanceof Error ? error.message : fallback` has
 * the precedence backwards: it *prefers* the raw thrown text and only reaches the written sentence
 * when the value is not an `Error`. So a `WRITE_SUSPENDED` ("Storage is full (Hard Stop): …") or a
 * `SQLITE_FULL` ("database or disk is full") reaches the user verbatim — jargon, and in English
 * whatever their language, because a raw message never passes through `t()`.
 *
 * Nothing enforced that until now: #681 found two write paths still on the old idiom — one of them
 * a few lines above a handler in the *same component* that resolves errors correctly — which is
 * what a conversion applied by hand looks like when it misses a neighbour. This scan makes the next
 * one a build failure rather than something spotted only if someone happens to read the handler,
 * the same "drift is a build failure" posture as the storage-key and `docs/todo` banner guards.
 *
 * Two deliberate limits on what it matches:
 *
 *   - Only the **ternary preferring the raw message** (`x instanceof Error ? x.message : …`). The
 *     guarded forms — `hasAuthoredMessage`, or a site that pairs `error.message` with its own
 *     diagnosis — are different code with different intent, and lumping them in would turn this
 *     into a lint that gets suppressed rather than a rule that holds.
 *   - `src/db/**` and `src/app/error/**` are out of scope: both sit *below* the copy layer.
 *     `DbError.fromUnknown` is what normalises a thrown value in the first place, and the crash
 *     screens deliberately show the raw error because a diagnostic is all that is left when the
 *     app itself could not start.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the storage-key and docs/todo guards).
const SRC_DIR = resolve(process.cwd(), 'src');

/** Directories that sit below the copy layer, so the raw message is the point rather than a leak. */
const EXCLUDED_DIRS = ['src/db', 'src/app/error'];

/**
 * `e instanceof Error ? e.message` — the same identifier on both sides, so this only matches the
 * idiom itself and not an unrelated narrowing that happens to mention `.message` nearby.
 */
const RAW_MESSAGE_TERNARY = /(\w+) instanceof Error\s*\?\s*\1\.message\b/;

/**
 * The remaining uses, each with the reason it is not a copy-layer bypass. `useErrorMessage` is a
 * React hook, so the pure modules here could not adopt it even if the raw text were wrong for them
 * — they are seams that classify or report an error, not places a sentence is shown to a user.
 */
const ALLOWED: Record<string, string> = {
  'src/features/errors/useErrorMessage.ts':
    'The seam itself, quoting the idiom in its docblock to say what it replaced.',
  'src/features/not-found/RouteErrorScreen.tsx':
    'The router error boundary — the peer of src/app/error, showing the raw error as a diagnostic ' +
    'when a route failed to render.',
  'src/features/search/queries.ts':
    'astError() reports why a search tree would not translate; parseASTtoSQL throws authored ' +
    'validation sentences, and this is a pure function with no hook available.',
  'src/features/inventory/catalog-import.ts':
    'Per-row diagnostics recorded in an import report, not copy shown as a failure sentence.',
  'src/features/sync/push-to-bridge.ts':
    'A pure function returning a PushResult message; buildPushRequest throws authored sentences.',
  'src/features/inventory/ocr/ocr-engine.ts':
    'describeOcrError() classifies the raw text to pick its own sentence — it never shows it.',
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Every non-test source file under `src/`, recursively, outside the excluded directories. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(SRC_DIR, path).replaceAll('\\', '/');
    if (EXCLUDED_DIRS.includes(`src/${rel}`)) continue;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Repo-relative paths of every file still using the idiom, sorted. */
function scanIdiom(): string[] {
  const found: string[] = [];
  for (const path of sourceFiles(SRC_DIR)) {
    if (RAW_MESSAGE_TERNARY.test(readFileSync(path, 'utf8'))) {
      found.push(relative(process.cwd(), path).replaceAll('\\', '/'));
    }
  }
  return found.sort();
}

const scanned = scanIdiom();

describe('error-copy seam — no raw-message bypasses', () => {
  it('scans a real tree (guards against a silently-empty sweep)', () => {
    // A broken walk or pattern would report zero bypasses — indistinguishable from a clean tree.
    // This seam's own docblock quotes the idiom, so it is a fixture the scan must always find.
    expect(scanned).toContain('src/features/errors/useErrorMessage.ts');
  });

  it('routes every thrown value shown to a user through useErrorMessage', () => {
    const bypasses = scanned.filter((path) => !(path in ALLOWED));
    expect(
      bypasses,
      'These prefer the raw thrown text over the written sentence, so a storage Hard Stop or a ' +
        'SQLITE_FULL reaches the user as jargon — and, never passing through t(), in English ' +
        'whatever their language. Resolve the error with `useErrorMessage()` instead:\n' +
        "  const describeError = useErrorMessage();\n  describeError(error, t('…')) \n" +
        'If the raw text genuinely is the point (a crash diagnostic, or a pure seam that ' +
        'classifies rather than shows), add the file to ALLOWED here with the reason.',
    ).toEqual([]);
  });

  it('keeps no stale exclusion', () => {
    const stale = Object.keys(ALLOWED).filter((path) => !scanned.includes(path));
    expect(
      stale.sort(),
      'Listed as an allowed use of the idiom, but no longer using it — remove the entry.',
    ).toEqual([]);
  });

  it('explains every exclusion, so a gap is a decision rather than an oversight', () => {
    for (const [path, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${path} needs a reason`).toBeGreaterThan(20);
    }
  });
});
