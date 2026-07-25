/**
 * Guards call sites against hand-rolling a native form control that Foundry already provides.
 *
 * A bare `<input type="checkbox">` or `<input type="radio">` looks harmless, so both kept
 * reappearing: every one had to re-declare `accent-primary` and a size, and every one went without
 * the disabled styling and the deliberate, contrast-checked focus outline the primitive supplies
 * (a raw control keeps whatever ring the browser happens to draw, which is neither themed nor
 * consistent between them). That is the "no hand-rolled bodges" rule in CLAUDE.md — a control that
 * duplicates a primitive's styling diverges from the design system, and nothing about it fails a
 * type-check or a component test.
 *
 * `Checkbox` (src/components/foundry/input.tsx) and `Radio` (src/components/foundry/radio.tsx) are
 * drop-ins: each fixes `type`, forwards its ref and spreads every other prop, so a call site keeps
 * its `checked` / `onChange` / `name` / `aria-label` / `data-testid` untouched and simply drops the
 * classes the primitive already owns. This scan makes reintroducing a raw one a build failure
 * rather than a review catch — the same posture as the storage-key registry, the `touch:`
 * hover-reveal pairing and the `docs/todo/` banner guards.
 *
 * Note the inversion versus those guards: a *passing* sweep here finds nothing beyond the
 * primitives themselves, so a pattern that quietly stopped matching would look identical to
 * success. Each control therefore carries a positive control — the primitive's own declaration
 * must still be found.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the other source-scanning guards).
const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * The native input types that have a Foundry primitive, each paired with the one file allowed to
 * declare it raw — which doubles as that control's positive control below.
 *
 * `type="text"` / `"number"` are deliberately absent: `Input` delegates rather than replaces (a
 * number field becomes `NumberInput`), so a raw text input is not automatically a bodge. Add an
 * entry here only when a primitive genuinely supersedes every raw use of that type.
 */
const GUARDED_CONTROLS = [
  { type: 'checkbox', primitive: 'Checkbox', owner: 'src/components/foundry/input.tsx' },
  { type: 'radio', primitive: 'Radio', owner: 'src/components/foundry/radio.tsx' },
] as const;

/**
 * Call sites that genuinely cannot use a primitive. Empty, and it should stay that way — the
 * primitives spread every input prop, so "it needs a prop the primitive doesn't take" is not a
 * reason. Add an entry only with a comment explaining what the primitive structurally cannot do.
 */
const ALLOW_LIST: readonly string[] = [];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

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

/**
 * A literal `type="<control>"` (either quote style). Deliberately does not try to catch a computed
 * `type={…}` — no call site does that, and matching it would need a parser rather than a regex.
 * `role="radio"` / `role="checkbox"` / `role="menuitemcheckbox"` are untouched on purpose: those
 * are ARIA roles on non-input elements (`SegmentedRadioGroup`'s buttons, menu items, colour
 * swatches), not hand-rolled inputs.
 */
function rawControlPattern(type: string): RegExp {
  return new RegExp(`type=(["'])${type}\\1`);
}

/** Repo-relative, forward-slashed paths of every non-test source file declaring `type="<type>"`. */
function scanFor(type: string): string[] {
  const pattern = rawControlPattern(type);
  return sourceFiles(SRC_DIR)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'));
}

const scanned = new Map(GUARDED_CONTROLS.map((control) => [control.type, scanFor(control.type)]));

describe.each(GUARDED_CONTROLS)(
  '$primitive is the only way to render a native $type',
  ({ type, primitive, owner }) => {
    const found = scanned.get(type) ?? [];

    it('still detects the primitive itself (positive control for the scan)', () => {
      expect(
        found,
        `The scan found no raw type="${type}" in ${owner}. Either the primitive stopped declaring ` +
          'one, or the pattern no longer matches — in which case this whole guard is silently passing.',
      ).toContain(owner);
    });

    it('has no hand-rolled control at a call site', () => {
      const offenders = found.filter((file) => file !== owner && !ALLOW_LIST.includes(file));
      expect(
        offenders,
        'These re-implement a control the design system already provides, so they miss its focus ' +
          `ring and disabled styling and duplicate its accent/size classes. Import \`${primitive}\` ` +
          "from '@/components/foundry' and drop `type` plus any size-4 / shrink-0 / cursor-pointer / " +
          'rounded / rounded-full / border-border / accent-primary / outline-none classes it already ' +
          'applies.',
      ).toEqual([]);
    });
  },
);

describe('the guard itself stays honest', () => {
  it('scans the whole source tree (guards against a silently-narrow sweep)', () => {
    // The per-control positive controls above prove the *pattern* still matches, but not that the
    // *walk* is still wide: both owner files are shallow `.tsx` files, so dropping `.ts` from
    // SOURCE_EXTENSIONS or failing to recurse past `src/components` would keep them green while
    // hiding every call site. ~940 non-test sources today; the floor is far below that so ordinary
    // growth or pruning never trips it, while either regression above does.
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(500);
  });

  it('does not allow-list a file that no longer declares a raw control', () => {
    const everyMatch = new Set([...scanned.values()].flat());
    const stale = ALLOW_LIST.filter((file) => !everyMatch.has(file));
    expect(stale, 'Remove these from ALLOW_LIST — they have no raw control left.').toEqual([]);
  });
});
