/**
 * Guards the ring bleed that keeps a clipping scroll container from shaving the focus/selection
 * ring off a control sitting flush against its edge (issue #417).
 *
 * Setting `overflow` on an element makes its box *clip* at the padding edge — and CSS resolves
 * the other axis away from `visible` too, so a scroller that only meant to scroll vertically
 * clips horizontally as well. A control against that edge then loses whatever it paints outside
 * its own border box. For the leading "No colour" swatch of the location dialogs that is a
 * permanent `ring-2 ring-offset-2` plus a `scale-110`, so the clip showed at rest, not only on
 * focus; for a tab that stretches to its rail's full width, it was the focus ring on both sides.
 * The fix is a negative margin cancelled by an equal padding: the box grows outwards into padding
 * the Surface already has, the content does not move, and the ring has room.
 *
 * Asserted against the sources rather than a rendered component because jsdom applies no Tailwind
 * utility, so no component test can see any of these declarations. Four things are checked, and
 * they fail for different reasons:
 *
 * 1. **`--spacing-ring-bleed` still exists and is still wide enough** for the widest ring the
 *    Foundry draws, on the control that magnifies it most.
 * 2. **Both utilities still bleed, and each bleed still cancels.** A bleed removed brings the
 *    clipping straight back; a bleed whose padding no longer matches its margin shifts the
 *    content sideways instead.
 * 3. **Every scroller found to clip a control still carries `ring-bleed-x`.** These are the ones
 *    `dialog-scroll` cannot reach, because each scrolls something of its own — a tab rail, a
 *    bounded list, a column taken out of flow. This list is what the sweep in #417 turned up; it
 *    is not a claim that no other scroller in the app will ever need it.
 * 4. **No call site hand-rolls the bleed the utilities own.** `Modal` used to carry its own copy,
 *    which is exactly why the fix reached the Modal-scrolled dialogs and missed the RailModal
 *    ones (Edit location among them). Centralising it is the whole of the fix, so a re-added
 *    local copy — beside either utility — is the regression to catch.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath, sourceFiles } from '../test/repo-path';

const REPO_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = repoPath(import.meta.dirname, 'src');
const CSS = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');

/** The declarations inside one `@utility <name> { … }` block, with comments stripped. */
function readUtility(name: string): Map<string, string> {
  const start = CSS.indexOf(`@utility ${name} {`);
  if (start === -1) throw new Error(`The \`${name}\` utility is gone from src/styles/index.css.`);
  const end = CSS.indexOf('\n}', start);
  if (end === -1) throw new Error(`The \`${name}\` utility block is unterminated.`);
  const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k!, v!.trim()]));
}

const DIALOG_SCROLL = readUtility('dialog-scroll');
const RING_BLEED = readUtility('ring-bleed-x');

/**
 * Every scroller that clips a control and cannot get the bleed from `dialog-scroll`, keyed by a
 * marker naming *that element* — see {@link classesOf} for how a marker resolves to a className.
 *
 * `variant` is the breakpoint the bleed must be scoped to, matching the breakpoint at which the
 * element becomes a scroller at all: the preset picker's sections wrap into chips below `sm:` and
 * clip nothing, and the region editor's column only leaves the flow at `lg:`.
 */
const SCROLLERS = [
  {
    what: 'the Foundry RailModal rail',
    file: ['src', 'components', 'foundry', 'rail-modal.tsx'],
    marker: 'aria-orientation="vertical"',
    variant: '',
    // A width is the border box, padding and all, so it has to carry the bleed in its own sum or
    // the section labels quietly lose exactly the room the bleed took.
    width: 'max-w-[calc(var(--spacing)*52+2*var(--spacing-ring-bleed))]',
  },
  {
    what: "the Erase-data dialog's category rail",
    file: ['src', 'features', 'danger-zone', 'EraseDataDialog.tsx'],
    marker: 'aria-label="Data categories"',
    variant: '',
    width: 'w-[calc(var(--spacing)*52+2*var(--spacing-ring-bleed))]',
  },
  {
    what: "the preset picker's section rail",
    file: ['src', 'features', 'inventory', 'components', 'CategoryPresetPicker.tsx'],
    marker: "aria-label={t('inventory.presets.sections.label')}",
    variant: 'sm:',
    // Sized by its parent column, so there is no declared width to compensate.
    width: null,
  },
  {
    what: "the region editor's out-of-flow column (it holds the colour swatches)",
    file: ['src', 'features', 'inventory', 'components', 'RegionEditorDialog.tsx'],
    marker: 'lg:overflow-y-auto',
    variant: 'lg:',
    width: null,
  },
  {
    what: "the category manager's bounded category list",
    file: ['src', 'features', 'inventory', 'components', 'CategoryManagerDialog.tsx'],
    marker: 'max-h-64',
    variant: '',
    width: null,
  },
  {
    // Not itself a scroller: the resizable frame around the emoji picker's group rail, which
    // clips for its resize handle. A bleed reaches only as far as the nearest clipping
    // ancestor, so the rail's own bleed does nothing until this box is bled too.
    what: "the emoji picker's resizable frame",
    file: ['src', 'components', 'foundry', 'emoji-picker', 'EmojiPicker.tsx'],
    marker: '[resize:both]',
    variant: '',
    width: null,
  },
] as const;

/**
 * The one place a bleed is the wrong answer: the gauge's segmented radiogroup clips for its
 * *rounded corners*, so bleeding it would hand the segments their square corners back. Its
 * ring is drawn inside the segment instead — the other way to keep a ring out of a clip.
 */
const RING_INSET = {
  file: ['src', 'features', 'inventory', 'components', 'GaugeAdjustDialog.tsx'],
  marker: 'focus-visible:ring-[3px]',
} as const;

/**
 * A horizontal margin utility, negated or not: the physical `ml-` / `mr-` / `mx-` and the
 * logical `ms-` / `me-`, each also matched behind a variant prefix (`sm:-mx-2`) — this codebase
 * leans on `sm:` and `handset:` heavily, so a bleed re-added at one breakpoint is the likeliest
 * spelling of the regression, not the bare one. Paired with either bleed utility on the same
 * line, it is the hand-rolled copy they now own. Only class strings written literally are read,
 * which is every call site today.
 */
const HORIZONTAL_MARGIN = /(?:^|[^\w-])-?m[lrxse]-[\w.[\]/-]+/;

/** The two utilities that own the bleed. A local margin beside either is the regression. */
const BLEED_UTILITIES = ['dialog-scroll', 'ring-bleed-x'];

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

/**
 * The classes of the className the marker identifies, split, so a check for one class is never
 * satisfied by another that merely contains it (`sm:ring-bleed-x` contains `ring-bleed-x`).
 *
 * A marker either sits *in* the className — a distinctive class of the element itself — or on an
 * attribute just above it, so both are resolved: the className containing the marker wins, and a
 * marker found elsewhere anchors to the first className after it.
 */
function classesOf(source: string, marker: string): readonly string[] {
  if (!source.includes(marker)) throw new Error(`No \`${marker}\` in the file — re-anchor this guard.`);
  const classNames = [...source.matchAll(/className="([^"]*)"/g)];
  const own = classNames.find((m) => m[1]!.includes(marker));
  if (own) return own[1]!.split(/\s+/);
  const at = source.indexOf(marker);
  const next = classNames.find((m) => m.index > at);
  if (!next) throw new Error(`No literal className follows \`${marker}\`.`);
  return next[1]!.split(/\s+/);
}

describe('the ring-bleed token (issue #417)', () => {
  it('is defined, and wide enough for the widest ring the Foundry draws', () => {
    const match = /--spacing-ring-bleed:\s*([\d.]+)rem\s*;/.exec(CSS);
    expect(match, '`--spacing-ring-bleed` is gone from src/styles/index.css.').not.toBeNull();
    // The worst case is the colour swatch: a 28px box, `focus-visible:ring-[3px] ring-offset-2`
    // (5px outside it), and `scale-110` when checked — and the scale magnifies the ring too, not
    // just the box. Painted half-extent (14 + 5) × 1.1 = 20.9px against a 14px layout half-box,
    // so 6.9px sits outside. Computed here rather than hard-coded, so the reason stays legible
    // when someone changes one of the three numbers.
    const outside = (14 + 5) * 1.1 - 14;
    expect(Number(match![1]) * 16).toBeGreaterThanOrEqual(outside);
  });
});

describe('the two bleed utilities cancel, so nothing shifts', () => {
  it('bleeds `dialog-scroll` right for the scrollbar and left for the ring', () => {
    expect(DIALOG_SCROLL.get('margin-right')).toBe('-1rem');
    expect(DIALOG_SCROLL.get('padding-right')).toBe('1rem');
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

  it('bleeds `ring-bleed-x` on both edges, as one inseparable pair', () => {
    // Written as `margin-inline`/`padding-inline` rather than four physical declarations so the
    // pair cannot be half-applied — which is the failure this whole guard exists to catch.
    expect(RING_BLEED.get('margin-inline')).toBe('calc(var(--spacing-ring-bleed) * -1)');
    expect(RING_BLEED.get('padding-inline')).toBe('var(--spacing-ring-bleed)');
  });

  it('keeps `dialog-scroll` clipping a stray-wide child rather than growing a horizontal bar', () => {
    expect(DIALOG_SCROLL.get('overflow-x')).toBe('hidden');
  });
});

describe('every scroller that clips a control carries the bleed', () => {
  it.each(SCROLLERS.map((s) => [s.what, s] as const))('%s', (_what, scroller) => {
    const source = readFileSync(repoPath(import.meta.dirname, ...scroller.file), 'utf8');
    const classes = classesOf(source, scroller.marker);
    // An exact class match, not a substring: `sm:ring-bleed-x` contains `ring-bleed-x`, so a
    // `toContain` would pass a bleed accidentally scoped to one breakpoint — the very mistake
    // this is here to catch.
    expect(
      classes,
      `${scroller.what} no longer bleeds, so the clip shaves the ring off the control against ` +
        'its edge (issue #417).',
    ).toContain(`${scroller.variant}ring-bleed-x`);
    if (scroller.width) expect(classes).toContain(scroller.width);
  });

  it('draws the gauge segments’ ring inside, where a bleed cannot help', () => {
    const source = readFileSync(repoPath(import.meta.dirname, ...RING_INSET.file), 'utf8');
    expect(
      source,
      'The gauge segments sit in a group that clips for its rounded corners, so their focus ' +
        'ring has to be inset — a bleed would square the corners off (issue #417).',
    ).toContain('focus-visible:ring-inset');
    expect(
      source,
      '`z-10` cannot lift a ring out of an ancestor’s overflow clip; it only read as if it could.',
    ).not.toContain('focus-visible:z-10');
  });
});

describe('no call site hand-rolls the bleed the utilities own', () => {
  const offenders = sourceFiles(SRC_DIR)
    .filter((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .some((line) => BLEED_UTILITIES.some((u) => line.includes(u)) && HORIZONTAL_MARGIN.test(line)),
    )
    .map(repoRelative);

  it('pairs neither utility with a local horizontal margin', () => {
    expect(
      offenders,
      'These re-add a bleed beside `dialog-scroll` or `ring-bleed-x`. It belongs in the ' +
        'utility, so every scroll area gets it — a local copy reaches only the one call site ' +
        '(issue #417).',
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
