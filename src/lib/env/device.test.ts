import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { repoPath } from '@/test/repo-path';
import {
  LARGE_FORMAT_QUERY,
  FOLDABLE_BOOK_QUERY,
  HOVER_NONE_QUERY,
  COARSE_POINTER_QUERY,
  isLargeFormat,
} from './device';

const realMatchMedia = globalThis.matchMedia;

afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

/** Stub `matchMedia` so it reports `matches` for the large-format query only. */
function stubMatchMedia(matches: boolean) {
  globalThis.matchMedia = vi.fn((query: string) => ({
    matches: query === LARGE_FORMAT_QUERY ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof matchMedia;
}

describe('device large-format detection (spec §2.4.2 / §3)', () => {
  it('keys off coarse pointer + a width and height floor, so a desktop or a phone in landscape is excluded', () => {
    // These three conditions are the whole contract (see device.ts); assert them
    // explicitly so a change to the discriminator is a deliberate, reviewed edit.
    expect(LARGE_FORMAT_QUERY).toBe('(min-width: 768px) and (min-height: 600px) and (pointer: coarse)');
  });

  it('exposes the foldable book-posture seam as a viewport-segments query', () => {
    expect(FOLDABLE_BOOK_QUERY).toBe('(horizontal-viewport-segments: 2)');
  });

  it('queries the large-format media feature', () => {
    stubMatchMedia(false);
    isLargeFormat();
    expect(globalThis.matchMedia).toHaveBeenCalledWith(LARGE_FORMAT_QUERY);
  });

  it('returns true on a large-format touch device', () => {
    stubMatchMedia(true);
    expect(isLargeFormat()).toBe(true);
  });

  it('returns false on a standard device', () => {
    stubMatchMedia(false);
    expect(isLargeFormat()).toBe(false);
  });

  it('falls back to false (standard frame) where matchMedia is unavailable', () => {
    // The CSS `large-format:` variant remains the authority in this case.
    (globalThis as { matchMedia?: typeof matchMedia }).matchMedia = undefined;
    expect(isLargeFormat()).toBe(false);
  });
});

/**
 * Guards the JS↔CSS parity behind the touch-hardware performance tier (issue #419).
 *
 * The stylesheet drops the surface frost under `(pointer: coarse)`; the weather layer trims its
 * backing-store resolution for the same devices, reading `COARSE_POINTER_QUERY`. They are one
 * decision — "this is touch hardware, spend less on decoration" — written once in CSS and once in
 * TypeScript. Let them drift and a device gets one half of the tier and not the other, which is
 * both a look nobody designed and a performance profile nobody measured.
 */
describe('coarse-pointer CSS/JS parity', () => {
  /** The media condition of the block that clears `--backdrop-surface`. */
  const BACKDROP_SURFACE_BLOCK = /@media\s+([^{]+?)\s*\{\s*:root\s*\{\s*--backdrop-surface:\s*none;/;

  it('drops the surface frost under exactly COARSE_POINTER_QUERY', () => {
    const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
    const match = BACKDROP_SURFACE_BLOCK.exec(css);

    expect(
      match,
      'no `@media … { :root { --backdrop-surface: none; …` block found in src/styles/index.css',
    ).not.toBeNull();
    expect(match?.[1]).toBe(COARSE_POINTER_QUERY);
  });
});

describe('hover-less CSS/JS parity', () => {
  /**
   * The `touch:` variant's media condition, in the same block form the `large-format:` guard below
   * matches. `HOVER_NONE_QUERY` and this variant are, again, two independent copies of one
   * condition in two languages — and the JS copy now decides whether the weather layer installs
   * its hover-follow listeners at all (`components/background/surface-map.ts`), while the CSS copy
   * decides whether the hover-only decoration those listeners follow is even drawn. Let them drift
   * and the app polls a control's lift on a device that never lifts it, or stops polling on one
   * that does — neither of which shows up anywhere but on real hardware.
   */
  const TOUCH_VARIANT = /@custom-variant\s+touch\s*\{\s*@media\s+([^{]+?)\s*\{/;

  it('declares the same media condition in the stylesheet as HOVER_NONE_QUERY', () => {
    const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
    const match = TOUCH_VARIANT.exec(css);

    expect(
      match,
      'no `@custom-variant touch { @media … {` block found in src/styles/index.css',
    ).not.toBeNull();
    expect(match?.[1]).toBe(HOVER_NONE_QUERY);
  });
});

/**
 * Guards the JS↔CSS parity that both sides *claim* but nothing checked (issue #251).
 *
 * `LARGE_FORMAT_QUERY` and the `large-format:` Tailwind custom variant are two independent
 * copies of the same media condition, written in two languages that can't import from one
 * another. Let them drift and JS and CSS disagree about what device they are on across a band
 * of viewport sizes: a component branching on `isLargeFormat()` renders the tablet layout
 * inside a phone-styled frame, or the reverse. That reproduces only on real hardware whose
 * screen falls in the gap, never in a test — which is exactly why the parity has to be
 * asserted mechanically rather than trusted to a pair of comments.
 */
describe('large-format CSS/JS parity', () => {
  /**
   * The variant's media condition, i.e. the `…` in:
   *
   *     @custom-variant large-format {
   *       @media … {
   *
   * Whitespace-tolerant so reformatting the stylesheet doesn't fail the run, but it matches
   * only the block form actually used — if the variant is ever rewritten some other way the
   * match fails and the test says so, rather than quietly passing on a stale assumption.
   */
  const LARGE_FORMAT_VARIANT = /@custom-variant\s+large-format\s*\{\s*@media\s+([^{]+?)\s*\{/;

  it('declares the same media condition in the stylesheet as LARGE_FORMAT_QUERY', () => {
    // Resolve from this test file's own checkout, not cwd: a worktree's suite can be run from
    // the primary checkout, and a cwd-relative read would then compare the *primary's* CSS
    // against the worktree's constant — passing on exactly the drift this guard exists to catch.
    const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
    const match = LARGE_FORMAT_VARIANT.exec(css);

    expect(
      match,
      'no `@custom-variant large-format { @media … {` block found in src/styles/index.css',
    ).not.toBeNull();
    expect(match?.[1]).toBe(LARGE_FORMAT_QUERY);
  });
});
