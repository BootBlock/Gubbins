/**
 * Guards against hiding content on a bare viewport-width breakpoint (issue #222).
 *
 * CSS pixels grow as the user zooms, so a 1280px desktop at 200% zoom measures the same ~640px as a
 * phone. A class string such as `hidden sm:inline` therefore takes content away from exactly the
 * low-vision user who zoomed in to read it (WCAG 1.4.4 Resize Text). The `handset:` variant in
 * `src/styles/index.css` pairs the width with `(pointer: coarse)`, so `handset:hidden` keeps the
 * compact treatment on a real phone while a zoomed or narrowed desktop keeps the content.
 *
 * Only hiding is checked: ordinary responsive sizing stays on `sm:` and the other breakpoints. A
 * breakpoint that hides content on a *wide* viewport (`lg:hidden`) is not flagged either, because a
 * zoomed user measures narrow and so keeps that content.
 *
 * The rule is per class string. A `cn()` call that puts `hidden` and its breakpoint in separate
 * arguments escapes it, so keep the two in one string.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the other source-scanning guards).
const SRC_DIR = resolve(process.cwd(), 'src');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

const STRING_LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;

const BREAKPOINT = '(?:sm|md|lg|xl|2xl)';

/** A display utility that brings back, from a width upwards, an element the same string hides. */
const SHOWN_FROM_WIDTH = new RegExp(
  `^${BREAKPOINT}:(?:block|inline|inline-block|inline-flex|flex|grid|inline-grid|table|contents)$`,
);

/** A utility that hides an element below a width. */
const HIDDEN_BELOW_WIDTH = new RegExp(`^max-${BREAKPOINT}:hidden$`);

/**
 * Class strings that hide an element below a width on purpose, written as `file: literal`. Each
 * must be an `aria-hidden` affordance of a layout that itself changes at that width, never content
 * a reader needs. Keep this short.
 */
const LAYOUT_ALLOW_LIST: readonly string[] = [
  // The dashboard's drag-to-place drop cells and drop ghost. They are positioned in the
  // three-column `sm:` grid, which collapses to a single column below that width.
  "src/features/dashboard/DashboardGrid.tsx: 'hidden min-h-24 rounded-2xl border-2 border-dashed border-border/60 sm:block'",
  "src/features/dashboard/DashboardGrid.tsx: 'pointer-events-none z-10 hidden self-stretch sm:block'",
];

/**
 * The string literals in `text` that hide content below a width. Tokens are whitespace-separated,
 * so a variant such as `empty:hidden` is not mistaken for the bare `hidden`.
 */
function widthHidingStrings(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)]
    .map((match) => match[0])
    .filter((literal) => {
      const tokens = literal.slice(1, -1).split(/\s+/);
      return (
        (tokens.includes('hidden') && tokens.some((token) => SHOWN_FROM_WIDTH.test(token))) ||
        tokens.some((token) => HIDDEN_BELOW_WIDTH.test(token))
      );
    });
}

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

const files = sourceFiles(SRC_DIR);

/** Every width-hiding class string in the source, as `file: literal`. */
const found = files.flatMap((path) => {
  const file = relative(process.cwd(), path).replaceAll('\\', '/');
  return widthHidingStrings(readFileSync(path, 'utf8')).map((literal) => `${file}: ${literal}`);
});

describe('content is never hidden on a bare width breakpoint', () => {
  it('scans source files that carry class names (guards against a silently-empty sweep)', () => {
    const withClassNames = files.filter((path) => readFileSync(path, 'utf8').includes('className='));
    expect(withClassNames.length).toBeGreaterThan(0);
  });

  it('recognises the shapes it forbids, and only those', () => {
    expect(widthHidingStrings('<span className="hidden sm:inline" />')).toHaveLength(1);
    expect(widthHidingStrings("cn('hidden w-28 items-center md:flex')")).toHaveLength(1);
    expect(widthHidingStrings('"max-lg:hidden"')).toHaveLength(1);
    expect(widthHidingStrings('"handset:hidden"')).toEqual([]);
    expect(widthHidingStrings('"lg:hidden"')).toEqual([]);
    expect(widthHidingStrings('"empty:hidden lg:flex-row"')).toEqual([]);
    expect(widthHidingStrings('"hidden"')).toEqual([]);
  });

  it('hides content with `handset:hidden`, never a width breakpoint', () => {
    expect(
      found.filter((entry) => !LAYOUT_ALLOW_LIST.includes(entry)),
      'These class strings hide content below a viewport width, which also hides it from a desktop ' +
        'user who zoomed in. Hide it on a real phone with `handset:hidden` (see the variant in ' +
        'src/styles/index.css), and let the layout wrap where the content no longer fits. Add the ' +
        'string to LAYOUT_ALLOW_LIST only if it is an aria-hidden part of a layout that itself ' +
        'changes at that width.',
    ).toEqual([]);
  });

  it('does not allow-list a class string that no longer exists', () => {
    expect(
      LAYOUT_ALLOW_LIST.filter((entry) => !found.includes(entry)),
      'Remove these from LAYOUT_ALLOW_LIST, or update them to the class string as it now reads.',
    ).toEqual([]);
  });
});
