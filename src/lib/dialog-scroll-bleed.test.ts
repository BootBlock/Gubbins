/**
 * Guards the ring bleed that keeps a clipping scroll container from shaving the focus/selection
 * ring off a control sitting flush against its edge (issue #417).
 *
 * Setting `overflow` on an element makes its box *clip* at the padding edge — and CSS resolves
 * the other axis away from `visible` too, so a scroller that only meant to scroll vertically
 * clips horizontally as well. A control against that edge then loses whatever it paints outside
 * its own border box. For the leading "No colour" swatch of the location dialogs that is a
 * permanent `ring-2 ring-offset-2` plus a `scale-110`, so the clip showed at rest, not only on
 * focus; for a tab in a vertical rail, which stretches to the rail's full width, it was the focus
 * ring on both sides. The fix is a negative margin cancelled by an equal padding: the box grows
 * outwards into padding the Surface already has, the content does not move, and the ring has room.
 *
 * Asserted against the sources rather than a rendered component because jsdom applies no Tailwind
 * utility, so no component test can see any of these declarations. Four things are checked, and
 * they fail for different reasons:
 *
 * 1. **`--spacing-ring-bleed` still exists and is still wide enough** for the widest ring the
 *    Foundry draws, on the control that magnifies it most.
 * 2. **`dialog-scroll` still bleeds both edges, and each bleed still cancels.** A bleed removed
 *    brings the clipping straight back; a bleed whose padding no longer matches its margin shifts
 *    every dialog's content sideways instead.
 * 3. **Every hand-built vertical rail still bleeds too.** A rail is not a `dialog-scroll` — it
 *    scrolls its own stack of tabs — so the utility cannot reach it, and there are three of them.
 * 4. **No call site hand-rolls the bleed `dialog-scroll` owns.** `Modal` used to carry its own
 *    copy, which is exactly why the fix reached the Modal-scrolled dialogs and missed the
 *    RailModal ones (Edit location among them). Centralising it is the whole of the fix, so a
 *    re-added local copy is the regression to catch.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath, sourceFiles } from '../test/repo-path';

const REPO_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = repoPath(import.meta.dirname, 'src');
const CSS = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');

/** The declarations inside `@utility dialog-scroll { … }`, with comments stripped. */
function readUtility(): Map<string, string> {
  const start = CSS.indexOf('@utility dialog-scroll {');
  if (start === -1) throw new Error('The `dialog-scroll` utility is gone from src/styles/index.css.');
  const end = CSS.indexOf('\n}', start);
  if (end === -1) throw new Error('The `dialog-scroll` utility block is unterminated.');
  const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k!, v!.trim()]));
}

const DIALOG_SCROLL = readUtility();

/**
 * The three hand-built vertical rails, each named by a marker that identifies *the rail element
 * itself* — its `className` is the next one in the file after that marker. A rail scrolls its own
 * tab stack, so it clips its own tabs, and `dialog-scroll` (which the neighbouring panel gets)
 * cannot reach it. The preset picker only becomes a scroller at `sm:`, so its bleed is scoped the
 * same way; below that its chips wrap and clip nothing.
 */
const RAILS = [
  {
    file: ['src', 'components', 'foundry', 'rail-modal.tsx'],
    marker: 'aria-orientation="vertical"',
    prefix: '',
    // The width cap applies to the border box, so it has to carry the padding, or the section
    // labels quietly lose exactly the room the bleed took.
    width: 'max-w-[calc(13rem+2*var(--spacing-ring-bleed))]',
  },
  {
    file: ['src', 'features', 'danger-zone', 'EraseDataDialog.tsx'],
    marker: 'aria-label="Data categories"',
    prefix: '',
    width: 'w-[calc(13rem+2*var(--spacing-ring-bleed))]',
  },
  {
    file: ['src', 'features', 'inventory', 'components', 'CategoryPresetPicker.tsx'],
    marker: "aria-label={t('inventory.presets.sections.label')}",
    prefix: 'sm:',
    // No width to compensate: this column is sized by its parent, not by the list itself.
    width: null,
  },
] as const;

/**
 * A horizontal margin utility, negated or not: the physical `ml-` / `mr-` / `mx-` and the
 * logical `ms-` / `me-`, each also matched behind a variant prefix (`sm:-mx-2`) — this codebase
 * leans on `sm:` and `handset:` heavily, so a bleed re-added at one breakpoint is the likeliest
 * spelling of the regression, not the bare one. Paired with a `dialog-scroll` on the same line,
 * it is the hand-rolled bleed the utility now owns. Only class strings written literally are
 * read, which is every call site today.
 */
const HORIZONTAL_MARGIN = /(?:^|[^\w-])-?m[lrxse]-[\w.[\]/-]+/;

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

describe('the ring-bleed token (issue #417)', () => {
  it('is defined, and wide enough for the widest ring the Foundry draws', () => {
    const match = /--spacing-ring-bleed:\s*([\d.]+)rem\s*;/.exec(CSS);
    expect(match, '`--spacing-ring-bleed` is gone from src/styles/index.css.').not.toBeNull();
    // The worst case is the colour swatch: a 28px box, `focus-visible:ring-[3px] ring-offset-2`
    // (5px outside it), and `scale-110` when checked — and the scale magnifies the ring too, not
    // just the box. Painted half-extent (14 + 5) × 1.1 = 20.9px against a 14px layout half-box,
    // so 6.9px sits outside. Computing it here rather than hard-coding 6.9 keeps the reason
    // legible when someone changes one of the three numbers.
    const outside = (14 + 5) * 1.1 - 14;
    expect(Number(match![1]) * 16).toBeGreaterThanOrEqual(outside);
  });
});

describe('dialog-scroll bleeds both horizontal edges', () => {
  it('bleeds the right edge for the scrollbar, and cancels it', () => {
    expect(DIALOG_SCROLL.get('margin-right')).toBe('-1rem');
    expect(DIALOG_SCROLL.get('padding-right')).toBe('1rem');
  });

  it('bleeds the left edge by the ring-bleed token, and cancels it', () => {
    expect(
      DIALOG_SCROLL.get('margin-left'),
      'Without a negative `margin-left`, the clip shaves the selection ring off the first ' +
        'control in a row — the "No colour" swatch in Edit location (issue #417).',
    ).toBe('calc(var(--spacing-ring-bleed) * -1)');
    expect(
      DIALOG_SCROLL.get('padding-left'),
      'The left padding must cancel the negative margin exactly, or every dialog shifts sideways.',
    ).toBe('var(--spacing-ring-bleed)');
  });

  it('still clips a stray-wide child rather than growing a horizontal bar', () => {
    expect(DIALOG_SCROLL.get('overflow-x')).toBe('hidden');
  });
});

describe("every vertical rail bleeds its own clip, so a tab's focus ring survives", () => {
  it.each(RAILS.map((rail) => [rail.file.at(-1)!, rail] as const))('%s', (_name, rail) => {
    const source = readFileSync(repoPath(import.meta.dirname, ...rail.file), 'utf8');
    const marker = source.indexOf(rail.marker);
    expect(marker, `The rail no longer carries \`${rail.marker}\` — re-anchor this guard.`).toBeGreaterThan(
      -1,
    );
    const className = /className="([^"]*)"/.exec(source.slice(marker))?.[1];
    expect(className, 'No literal className follows the rail marker.').toBeDefined();
    expect(className).toContain(`${rail.prefix}-mx-ring-bleed`);
    expect(className).toContain(`${rail.prefix}px-ring-bleed`);
    if (rail.width) expect(className).toContain(rail.width);
  });
});

describe('no call site hand-rolls the bleed the utility owns', () => {
  const offenders = sourceFiles(SRC_DIR)
    .filter((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .some((line) => line.includes('dialog-scroll') && HORIZONTAL_MARGIN.test(line)),
    )
    .map(repoRelative);

  it('pairs `dialog-scroll` with no local horizontal margin', () => {
    expect(
      offenders,
      'These re-add a bleed beside `dialog-scroll`. It belongs in the utility, so that every ' +
        'dialog scroll area gets it — a local copy reaches only the one call site (issue #417).',
    ).toEqual([]);
  });

  it('still matches the shape issue #417 removed, and its variants (positive control)', () => {
    // A passing sweep finds nothing, which is indistinguishable from a pattern that quietly
    // stopped matching — so re-run it against the line the fix actually deleted, and against the
    // spellings a re-added bleed is likelier to take in a codebase this full of variants.
    const removed = `cn('mt-5 min-h-0', scrollBody ? 'dialog-scroll -ml-2 pl-2' : 'flex flex-col')`;
    expect(HORIZONTAL_MARGIN.test(removed)).toBe(true);
    expect(HORIZONTAL_MARGIN.test(removed.replace(' -ml-2 pl-2', ''))).toBe(false);
    expect(HORIZONTAL_MARGIN.test(`className="dialog-scroll sm:-mx-2 sm:px-2"`)).toBe(true);
    expect(HORIZONTAL_MARGIN.test(`className="dialog-scroll handset:-ml-2 handset:pl-2"`)).toBe(true);
    expect(HORIZONTAL_MARGIN.test(`className="dialog-scroll -ms-2 ps-2"`)).toBe(true);
  });

  it('leaves an ordinary dialog-scroll class alone (negative control)', () => {
    // Every one of these carries an `m`-prefixed utility that is *not* a horizontal margin, so a
    // pattern widened too far would start reporting the whole codebase.
    expect(HORIZONTAL_MARGIN.test(`className="dialog-scroll flex min-h-0 flex-1 flex-col"`)).toBe(false);
    expect(HORIZONTAL_MARGIN.test(`className="dialog-scroll mt-5 mb-field-gap max-w-lg"`)).toBe(false);
  });

  it('scans the whole source tree (guards against a silently-narrow sweep)', () => {
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(500);
  });
});
