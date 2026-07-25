import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LARGE_FORMAT_QUERY, FOLDABLE_BOOK_QUERY, isLargeFormat } from './device';

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
    // Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL,
    // not a file: one, so resolve against cwd (as the other source-reading guards do).
    const css = readFileSync(resolve(process.cwd(), 'src/styles/index.css'), 'utf8');
    const match = LARGE_FORMAT_VARIANT.exec(css);

    expect(
      match,
      'no `@custom-variant large-format { @media … {` block found in src/styles/index.css',
    ).not.toBeNull();
    expect(match?.[1]).toBe(LARGE_FORMAT_QUERY);
  });
});
