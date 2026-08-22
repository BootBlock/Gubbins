/**
 * Guards the eagerly-loaded boot path against re-acquiring the lifecycle dialogs.
 *
 * `useAlerts` powers the alert badge in `AppNav`, which `PageHeader` mounts, which the
 * `@/components/foundry` barrel re-exports — so every one of `useAlerts`'s static imports lands in
 * the modulepreloaded entry chunk and is downloaded, parsed and evaluated before first paint.
 * The badge needs three counts. It used to reach them through the `@/features/lifecycle` barrel,
 * which also re-exported the Audit Day and Cycle Count dialogs and the Kit / Lifecycle /
 * Maintenance editors; those import back from `@/components/foundry`, closing an import cycle the
 * bundler cannot split, and ~80 KB of dialog source came with them for users who never open an
 * item's tabs or start a stock take. Their real consumers (`ItemDetailDialog`, `InventoryScreen`)
 * are lazily reached and import each component from its own module instead.
 *
 * Nothing about that regression is visible to a type-check or a component test — re-adding one
 * `export { AuditDayDialog }` line to the barrel restores it silently — so this walks the static
 * import graph and fails the build instead.
 *
 * Dynamic `import(...)` is deliberately not followed: it is what puts a module in its own chunk,
 * so a lazily-reached component is not a finding.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`. A worktree's suite
// can be run from the primary checkout, and a cwd-relative guard would then walk the *primary's*
// import graph and report green while the worktree's edits went unchecked.
const PROJECT_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = join(PROJECT_ROOT, 'src');

/** The module the eager boot path pulls in — `AppNav` imports it directly. */
const ENTRY = join(SRC_DIR, 'features', 'alerts', 'useAlerts.ts');

/** Heavy React components that must stay off the eager path, as repo-relative paths. */
const FORBIDDEN_PREFIX = 'src/features/lifecycle/components/';

/**
 * Modules the walk must reach. Without them, a walk that quietly stopped following imports would
 * look identical to a clean graph. The first is a direct import of the entry, so it proves the
 * resolver works; the second is reached only *through* the first, so it proves the walk recurses
 * rather than certifying one hop.
 */
const POSITIVE_CONTROLS = [
  join(SRC_DIR, 'features', 'lifecycle', 'hooks.ts'),
  join(SRC_DIR, 'features', 'calendar', 'keys.ts'),
];

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Resolves a `@/…` or relative specifier to a file under `src/`, or null for a package import. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every statically imported specifier in `source`, excluding type-only statements (erased at
 * build time) and dynamic `import(...)` (which creates a chunk boundary rather than crossing one).
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  // The clause between the keyword and `from` is bounded by `[^;]*?`, not `[\s\S]*?`: an import
  // clause never contains a semicolon, whereas a statement with no `from` of its own (say
  // `export type { Foo };`) would otherwise open a match that ran on to the *next* statement's
  // `from '…'`, be discarded as type-only, and take a genuine value import down with it.
  const statement = /(?:^|\n)\s*(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (const [, clause, specifier] of source.matchAll(statement)) {
    if (/^\s*type\b/.test(clause)) continue;
    out.push(specifier);
  }
  // Side-effect imports (`import '@/foo'`) carry no clause, so the pattern above misses them.
  for (const [, specifier] of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    out.push(specifier);
  }
  return out;
}

/** Every module statically reachable from `entry`, as absolute paths. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const source = readFileSync(file, 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, file);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

describe('the @/features/lifecycle barrel', () => {
  it('re-exports nothing from ./components', () => {
    const barrel = readFileSync(join(SRC_DIR, 'features', 'lifecycle', 'index.ts'), 'utf8');
    const componentReExports = [...barrel.matchAll(/from\s*'(\.\/components\/[^']+)'/g)].map(
      ([, specifier]) => specifier,
    );

    expect(componentReExports).toEqual([]);
  });
});

describe('the static-import parser', () => {
  it('keeps a value import that follows a type-only re-export', () => {
    // The shape that broke an earlier revision: `export type { … };` has no `from` of its own, so
    // an unbounded clause swallowed the following import and the whole subtree behind it went
    // unwalked — a hole the reachability assertion below could not see.
    const source = [
      "import { a, type B } from '@/one';",
      'export type { B };',
      "import { c } from '@/two';",
      "export type { D } from '@/three';",
      "import '@/four';",
    ].join('\n');

    expect(staticSpecifiers(source).sort()).toEqual(['@/four', '@/one', '@/two']);
  });
});

describe('the eager alert-badge import graph', () => {
  const reachable = reachableFrom(ENTRY);

  it.each(POSITIVE_CONTROLS)('still walks as far as %s', (control) => {
    expect(reachable.has(control)).toBe(true);
  });

  it('does not statically reach any lifecycle dialog or editor', () => {
    const offenders = [...reachable]
      .map((file) => relative(PROJECT_ROOT, file).replaceAll('\\', '/'))
      .filter((file) => file.startsWith(FORBIDDEN_PREFIX))
      .sort();

    expect(offenders).toEqual([]);
  });
});
