import { describe, it, expect, afterEach, vi } from 'vitest';
import { PREFERS_REDUCED_MOTION_QUERY, prefersReducedMotion } from './motion';

const realMatchMedia = globalThis.matchMedia;

afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

/** Stub `matchMedia` so it reports `matches` for the reduced-motion query. */
function stubMatchMedia(matches: boolean) {
  globalThis.matchMedia = vi.fn((query: string) => ({
    matches: query === PREFERS_REDUCED_MOTION_QUERY ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof matchMedia;
}

describe('prefersReducedMotion (spec §3 / WCAG 2.3.3)', () => {
  it('queries the reduced-motion media feature', () => {
    stubMatchMedia(false);
    prefersReducedMotion();
    expect(globalThis.matchMedia).toHaveBeenCalledWith(PREFERS_REDUCED_MOTION_QUERY);
  });

  it('returns true when the OS prefers reduced motion', () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when the OS does not prefer reduced motion', () => {
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('falls back to false (full motion) where matchMedia is unavailable', () => {
    // The CSS @media query is the authority in this case, so nothing is lost.
    (globalThis as { matchMedia?: typeof matchMedia }).matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});
