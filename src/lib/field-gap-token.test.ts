/**
 * Guards the label→control gap against being hand-rolled back to a raw sub-token value.
 *
 * `--spacing-field-gap-compact` (src/styles/index.css) is the 8px gap for the dense `text-xs`
 * label tier, exposed as `mb-field-gap-compact` / `gap-field-gap-compact` /
 * `space-y-field-gap-compact`. `space-y-1` and `flex flex-col gap-1` produce 4px, so a field that
 * spells its gap that way sits half as close to its control as every other field on the same
 * screen — and a future tweak to the field rhythm silently skips it. Issue #668 found nine such
 * fields, two of them stacked directly above a tokenised sibling in the Import dialog.
 *
 * Nothing about a raw `gap-1` fails a type-check or a component test, so this scan is the same
 * posture as the Foundry native-input, storage-key and `docs/todo/` banner guards: make the
 * regression a build failure rather than a review catch.
 *
 * Two limits of the match, stated so a future reader does not over-trust it:
 *
 * 1. A raw 4px gap is only wrong when the element is a *field*, so the pattern requires a Foundry
 *    control to follow within roughly one element's worth of JSX. That proximity rule is the only
 *    thing keeping a `<ul className="space-y-1">` out — the className half matches a list just as
 *    happily as a field. A list that genuinely sits within the window above an `Input` would be a
 *    false positive; none does today. Icon rows (`flex items-center gap-1`, no `flex-col`) and the
 *    half-step `1.5` values are excluded structurally rather than by luck.
 * 2. Only a literal double-quoted `className="…"` is read. A field composing its classes through
 *    `cn(…)` or a template literal is invisible to the sweep. No call site does that today.
 */
import { relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath, sourceFiles } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = repoPath(import.meta.dirname, 'src');

/**
 * A `className` that sets the 4px stack gap, followed within one element's worth of JSX by a
 * Foundry control — i.e. a label-above-control field that bypassed the token.
 *
 * `(?![\w.-])` keeps `gap-1.5` / `space-y-10` out: those are different values, not this one
 * misspelt. The 400-character window is roughly a caption plus its opening tag — wide enough for
 * an `id={…}` span with an `InfoHint` beside it, narrow enough that an unrelated control further
 * down the tree doesn't drag a bullet list into the net.
 */
const RAW_FIELD_GAP =
  /className="[^"]*(?:space-y-1(?![\w.-])|flex-col\s+gap-1(?![\w.-]))[^"]*"[\s\S]{0,400}?<(?:Select|Input|Textarea|NumberInput)\b/;

/**
 * Call sites that genuinely want 4px between a caption and a control. Empty, and it should stay
 * that way — if a field needs to be denser than the compact tier, that is a new token, not a
 * literal (CLAUDE.md, "Controls & spacing"). Add an entry only with a comment saying why.
 */
const ALLOW_LIST: readonly string[] = [];

/** Repo-relative, forward-slashed path, so offenders and `ALLOW_LIST` share one spelling. */
function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

const scanned = sourceFiles(SRC_DIR)
  .filter((path) => RAW_FIELD_GAP.test(readFileSync(path, 'utf8')))
  .map(repoRelative);

describe('label→control gaps come from the field-gap-compact token (issue #668)', () => {
  it('has no field that hand-rolls the 4px gap', () => {
    const offenders = scanned.filter((path) => !ALLOW_LIST.includes(path));
    expect(
      offenders,
      'These stack a caption above a Foundry control at 4px instead of the 8px compact tier, so ' +
        'the label crowds its box and a change to the field rhythm skips them. Replace ' +
        '`space-y-1` with `space-y-field-gap-compact` and `flex flex-col gap-1` with ' +
        '`flex flex-col gap-field-gap-compact`.',
    ).toEqual([]);
  });
});

describe('the guard itself stays honest', () => {
  it('still matches a field that hand-rolls the gap (positive control)', () => {
    // A passing sweep finds nothing, which is indistinguishable from a pattern that quietly
    // stopped matching — so re-run it against the shape issue #668 actually removed.
    const removed = `
      <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        <span id={labelId}>{label}</span>
        <Select aria-labelledby={labelId} {...props} />
      </div>`;
    expect(RAW_FIELD_GAP.test(removed)).toBe(true);
    expect(RAW_FIELD_GAP.test(removed.replace('gap-1 ', 'gap-field-gap-compact '))).toBe(false);
  });

  it('leaves non-field uses of the same value alone (negative control)', () => {
    const iconRow = `<span className="flex items-center gap-1"><Icon /><Input /></span>`;
    const halfStep = `<div className="space-y-1.5"><span>Query</span><Input /></div>`;
    expect(RAW_FIELD_GAP.test(iconRow)).toBe(false);
    expect(RAW_FIELD_GAP.test(halfStep)).toBe(false);
  });

  it('scans the whole source tree (guards against a silently-narrow sweep)', () => {
    // The positive control proves the *pattern* still matches, not that the *walk* is still wide:
    // failing to recurse past `src/lib` would keep every assertion above green while hiding every
    // call site. ~1010 non-test sources today; the floor sits far below that so ordinary growth
    // or pruning never trips it.
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(500);
  });

  it('does not allow-list a file that no longer hand-rolls the gap', () => {
    const stale = ALLOW_LIST.filter((file) => !scanned.includes(file));
    expect(stale, 'Remove these from ALLOW_LIST — they use the token now.').toEqual([]);
  });
});
