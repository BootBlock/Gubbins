/**
 * Guards the query-key factories (issue #379).
 *
 * A TanStack query key is a contract between a reader and every writer that has to refresh it,
 * and nothing type-checks it: `['agenda']` spelled at six `useQuery` sites and one
 * `invalidateQueries` is seven independent copies of the same string, so a new feed or a new
 * mutation has nowhere to be checked against. That is not hypothetical — it is the mechanical
 * cause of both stale-data reports filed alongside this one (#374, #375).
 *
 * The convention is therefore: **every key comes from a `…Keys` factory**, each domain's
 * factory declares the single-segment prefix its keys hang off, and no prefix is shared by two
 * domains. This scan makes breaking that a build failure rather than a review catch — the same
 * posture as the storage-key registry and `docs/todo/` banner guards.
 *
 * What it cannot check is whether a key is keyed on the *right* inputs. Naming a member is what
 * puts that decision somewhere it can be compared with its neighbours; the judgement stays
 * yours.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath, sourceFiles } from '@/test/repo-path';

// Rooted in this file's own checkout, and swept with the shared walker, so a worktree's suite run
// from the primary checkout can't sweep the *primary's* sources and pass without ever seeing the
// change under test.
const SRC_DIR = repoPath(import.meta.dirname, 'src');

/** A key spelled as an array literal at the call site, rather than taken from a factory. */
const INLINE_QUERY_KEY = /queryKey:\s*\[/g;

/**
 * The `QueryClient` methods that take a key as their first positional argument, caught with the
 * same rule — `client.setQueryData(['contacts'], …)` bypasses a factory exactly as an inline
 * `queryKey:` property does.
 */
const INLINE_POSITIONAL_KEY =
  /\.(setQueryData|getQueryData|setQueriesData|getQueriesData|removeQueries|cancelQueries|refetchQueries|invalidateQueries|prefetchQuery|fetchQuery|ensureQueryData)\(\s*\[/g;

/** The opening line of a factory: `export const inventoryKeys = {` (the export is optional). */
const FACTORY_OPEN = /^(?:export )?const (\w+Keys) = \{$/;
/** The `all: ['inventory'] as const,` root every factory declares. */
const FACTORY_ROOT = /^\s*all: \[(.*)] as const,$/;
/** A root holding exactly one quoted string segment. */
const SINGLE_SEGMENT = /^'([a-z0-9-]+)'$/;

const FILES = sourceFiles(SRC_DIR).map((path) => ({
  path: relative(process.cwd(), path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

/** Where a rule was broken, as `path:line`, for a failure message that points at the code. */
function offenders(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    file.text.split(/\r?\n/).forEach((line, i) => {
      // Each scan gets a fresh lastIndex — these are global regexes reused across files.
      pattern.lastIndex = 0;
      if (pattern.test(line)) out.push(`${file.path}:${i + 1}`);
    });
  }
  return out;
}

/** Every `…Keys` factory in the tree, with the prefix it declares. */
function factories(): { name: string; file: string; root: string | null }[] {
  const found: { name: string; file: string; root: string | null }[] = [];
  for (const file of FILES) {
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const opened = FACTORY_OPEN.exec(line);
      if (!opened) return;
      let root: string | null = null;
      // Bounded by the object's own closing brace at column 0, so a factory that declares no
      // root reads as rootless rather than silently borrowing the next factory's.
      for (let j = i + 1; j < lines.length && !lines[j]!.startsWith('}'); j++) {
        const rootLine = FACTORY_ROOT.exec(lines[j]!);
        if (rootLine) {
          root = SINGLE_SEGMENT.exec(rootLine[1]!)?.[1] ?? null;
          break;
        }
      }
      found.push({ name: opened[1]!, file: file.path, root });
    });
  }
  return found;
}

const FACTORIES = factories();

describe('query-key factories', () => {
  it('scans the source tree at all (guards against a silently-empty sweep)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FACTORIES.length).toBeGreaterThan(15);
  });

  it('builds every query key from a factory rather than an inline array literal', () => {
    expect(
      offenders(INLINE_QUERY_KEY),
      'A key spelled at the call site is a copy no reader or writer can be checked against — ' +
        "the cause of issues #374 and #375. Add a named member to the domain's `…Keys` factory " +
        '(e.g. src/features/reports/keys.ts) and call it here instead.',
    ).toEqual([]);
  });

  it('passes a factory key to every QueryClient method that takes one positionally', () => {
    expect(
      offenders(INLINE_POSITIONAL_KEY),
      "Same rule as `queryKey:` — take the key from the domain's `…Keys` factory.",
    ).toEqual([]);
  });

  it('declares a single-segment `all` prefix in every factory', () => {
    // The prefix is what makes "refresh this whole domain" expressible in one call, so a factory
    // without one leaves its writers naming individual members and missing the next one added.
    const rootless = FACTORIES.filter((f) => f.root === null);
    expect(
      rootless.map((f) => `${f.name} (${f.file})`),
      "Each factory needs an `all: ['<prefix>'] as const,` root holding exactly one segment.",
    ).toEqual([]);
  });

  it('gives every factory its own prefix', () => {
    // Two domains sharing a prefix would silently invalidate each other's caches — cheap when it
    // is only wasted refetches, wrong when one of them is holding optimistic state.
    const byRoot = new Map<string, string[]>();
    for (const f of FACTORIES) {
      if (f.root === null) continue;
      byRoot.set(f.root, [...(byRoot.get(f.root) ?? []), `${f.name} (${f.file})`]);
    }
    const shared = [...byRoot.entries()].filter(([, owners]) => owners.length > 1);
    expect(
      shared.map(([root, owners]) => `'${root}' claimed by ${owners.join(' and ')}`),
      'Two factories claim the same prefix, so each invalidates the other by accident.',
    ).toEqual([]);
  });
});
