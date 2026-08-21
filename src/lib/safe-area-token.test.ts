/**
 * Guards the safe-area contract: `viewport-fit=cover` and the tokens that honour it stay
 * together, and no call site spells an inset as a raw `env()` literal.
 *
 * `index.html` opts the app into drawing under the status bar, a notch and the gesture home
 * bar. That opt-in is only safe while something subtracts `env(safe-area-inset-*)` back out
 * again — issue #655 found the app had kept the opt-in for its whole life with no inset
 * anywhere, so the scanner's Close button sat under the status bar and the toast's action sat
 * in the home-indicator strip. Nothing about that fails a type-check or a component test: the
 * insets are `0px` on every desktop browser the suite runs in, so the bug is invisible until
 * it reaches a phone.
 *
 * Two halves, matching the two ways it can regress:
 *
 * 1. **The pairing.** Keeping cover mode obliges the stylesheet to define the tokens. Dropping
 *    cover mode is the other coherent answer, and this guard permits it — it asserts the
 *    tokens only while the opt-in is there.
 * 2. **The spelling.** One definition per edge, consumed through ordinary utilities. A raw
 *    `env(safe-area-inset-…)` at a call site bypasses the family, so a later change to how the
 *    app treats an edge skips it — the same posture as the field-gap and storage-key guards.
 */
import { relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath, sourceFiles } from '../test/repo-path';

const REPO_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = repoPath(import.meta.dirname, 'src');
const STYLESHEET = repoPath(import.meta.dirname, 'src', 'styles', 'index.css');

const css = readFileSync(STYLESHEET, 'utf8');
const html = readFileSync(repoPath(import.meta.dirname, 'index.html'), 'utf8');

/**
 * The whole family the stylesheet defines. `--spacing-safe-top` is the one entry no call site
 * consumes yet (every top-edge site wants the gutter form) — it is listed because the guard
 * asserts the family is complete, not that each member is in use.
 */
const TOKENS = [
  '--spacing-safe-top',
  '--spacing-safe-bottom',
  '--spacing-safe-left',
  '--spacing-safe-right',
  '--spacing-safe-gutter-top',
  '--spacing-safe-gutter-bottom',
  '--spacing-safe-gutter-left',
  '--spacing-safe-gutter-right',
  '--spacing-safe-gutter-x',
  '--spacing-safe-gutter-x-lg',
  '--spacing-safe-page-top',
  '--spacing-safe-page-bottom',
  '--spacing-safe-dialog',
] as const;

/** Repo-relative, forward-slashed, so an offender reads the same on any platform. */
function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

describe('safe-area insets (issue #655)', () => {
  it('defines every safe-area spacing token while `viewport-fit=cover` is opted into', () => {
    if (!html.includes('viewport-fit=cover')) return; // The other coherent answer — see above.

    const missing = TOKENS.filter((token) => !css.includes(`${token}:`));
    expect(
      missing,
      'index.html asks the platform for the whole physical display, so styles/index.css owes it ' +
        'a token for each edge it must then subtract back. A missing token is silent: an unknown ' +
        'Tailwind utility emits no CSS and no error, so the call sites keep their classes and ' +
        'simply stop insetting.',
    ).toEqual([]);
  });

  it('resolves every safe-area token from `env()`, with a 0px fallback', () => {
    for (const token of TOKENS.filter((t) => t !== '--spacing-safe-dialog')) {
      const declaration = new RegExp(`${token}:[^;]*`).exec(css)?.[0] ?? '';
      expect(declaration, `${token} should read an env() inset`).toContain('env(safe-area-inset-');
      expect(declaration, `${token} should fall back to 0px off a reporting device`).toContain('0px');
    }
  });

  it('keeps `cn`’s tailwind-merge scale in step with the stylesheet', () => {
    // tailwind-merge resolves a conflict by recognising the *value* half of a utility, so `cn`
    // (src/lib/utils.ts) names this scale to keep a caller’s `className` override winning over a
    // Foundry base built from these tokens. A token added to the stylesheet and forgotten there
    // fails silently — both classes survive the merge and the stylesheet order decides.
    const utils = readFileSync(repoPath(import.meta.dirname, 'src', 'lib', 'utils.ts'), 'utf8');
    const declared = /const SAFE_AREA_SPACING = \[([^\]]*)\]/.exec(utils)?.[1] ?? '';
    const registered = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...registered].sort()).toEqual(TOKENS.map((token) => token.replace('--spacing-', '')).sort());
  });

  it('has no call site spelling an inset as a raw env() literal', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((path) => readFileSync(path, 'utf8').includes('env(safe-area-inset-'))
      .map(repoRelative);
    expect(
      offenders,
      'Use the `safe-*` spacing utilities (`pt-safe-gutter-top`, `mb-safe-bottom`, ' +
        '`px-safe-gutter-x`) rather than an inline env() — one definition per edge, in ' +
        'styles/index.css.',
    ).toEqual([]);
  });
});
