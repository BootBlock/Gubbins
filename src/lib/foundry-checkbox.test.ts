/**
 * Guards call sites against hand-rolling a checkbox instead of using the Foundry `Checkbox`.
 *
 * A bare `<input type="checkbox">` looks harmless, so it kept reappearing: every one of them had
 * to re-declare `accent-primary` and a size, and every one of them silently skipped the keyboard
 * focus ring and the disabled styling the primitive supplies. That is the "no hand-rolled bodges"
 * rule in CLAUDE.md — a control that duplicates a primitive's styling diverges from the design
 * system, and nothing about it fails a type-check or a component test.
 *
 * `Checkbox` (src/components/foundry/input.tsx) is a drop-in: it fixes `type`, forwards its ref
 * and spreads every other prop, so a call site keeps its `checked` / `onChange` / `aria-label` /
 * `data-testid` untouched and simply drops the classes the primitive already owns. This scan makes
 * reintroducing a raw one a build failure rather than a review catch — the same posture as the
 * storage-key registry, the `touch:` hover-reveal pairing and the `docs/todo/` banner guards.
 *
 * Note the inversion versus those guards: a *passing* sweep here finds nothing, so a regex that
 * quietly stopped matching would look identical to success. The first test is therefore a positive
 * control — it asserts the pattern still finds the primitive's own declaration.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the other source-scanning guards).
const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * A literal `type="checkbox"` (either quote style). Deliberately does not try to catch a computed
 * `type={…}` — no call site does that, and matching it would need a parser rather than a regex.
 * `role="checkbox"` and `role="menuitemcheckbox"` are untouched on purpose: those are ARIA roles
 * on non-input elements (menu items, table select-all cells), not hand-rolled inputs.
 */
const RAW_CHECKBOX = /type=(["'])checkbox\1/;

/**
 * The one file allowed to declare a raw checkbox: the primitive that every call site defers to.
 * It is also the positive control below, so it must keep matching {@link RAW_CHECKBOX}.
 */
const PRIMITIVE = 'src/components/foundry/input.tsx';

/**
 * Call sites that genuinely cannot use the primitive. Empty, and it should stay that way — the
 * primitive spreads every input prop, so "it needs a prop Checkbox doesn't take" is not a reason.
 * Add an entry only with a comment explaining what the primitive structurally cannot do.
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

/** Repo-relative, forward-slashed paths of every non-test source file declaring a raw checkbox. */
function scanRawCheckboxes(): string[] {
  return sourceFiles(SRC_DIR)
    .filter((path) => RAW_CHECKBOX.test(readFileSync(path, 'utf8')))
    .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'));
}

const scanned = scanRawCheckboxes();

describe('checkboxes go through the Foundry primitive', () => {
  it('still detects the primitive itself (positive control for the scan)', () => {
    expect(
      scanned,
      `The scan found no raw checkbox in ${PRIMITIVE}. Either the primitive stopped declaring one, ` +
        'or RAW_CHECKBOX no longer matches — in which case this whole guard is silently passing.',
    ).toContain(PRIMITIVE);
  });

  it('has no hand-rolled checkbox at a call site', () => {
    const offenders = scanned.filter((file) => file !== PRIMITIVE && !ALLOW_LIST.includes(file));
    expect(
      offenders,
      'These re-implement a control the design system already provides, so they miss its focus ring ' +
        'and disabled styling and duplicate its accent/size classes. Import `Checkbox` from ' +
        "'@/components/foundry' and drop `type` plus any size-4 / shrink-0 / cursor-pointer / " +
        'rounded / border-border / accent-primary / outline-none classes it already applies.',
    ).toEqual([]);
  });

  it('does not allow-list a file that no longer declares one', () => {
    const stale = ALLOW_LIST.filter((file) => !scanned.includes(file));
    expect(stale, 'Remove these from ALLOW_LIST — they have no raw checkbox left.').toEqual([]);
  });
});
