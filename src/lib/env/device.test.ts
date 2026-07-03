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
