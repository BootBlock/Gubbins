import { describe, it, expect, afterEach, vi } from 'vitest';
import { STANDALONE_DISPLAY_QUERY, isStandaloneDisplay } from './install';

const realMatchMedia = globalThis.matchMedia;
const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
const realStandalone = navigatorWithStandalone.standalone;

afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
  if (realStandalone === undefined) {
    delete navigatorWithStandalone.standalone;
  } else {
    navigatorWithStandalone.standalone = realStandalone;
  }
  vi.restoreAllMocks();
});

/** Stub `matchMedia` so it reports `matches` for the display-mode query. */
function stubMatchMedia(matches: boolean) {
  globalThis.matchMedia = vi.fn((query: string) => ({
    matches: query === STANDALONE_DISPLAY_QUERY ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof matchMedia;
}

describe('isStandaloneDisplay (spec §2 PWA installation)', () => {
  it('queries the standalone display-mode media feature', () => {
    delete navigatorWithStandalone.standalone;
    stubMatchMedia(false);
    isStandaloneDisplay();
    expect(globalThis.matchMedia).toHaveBeenCalledWith(STANDALONE_DISPLAY_QUERY);
  });

  it('returns true when running in a standalone display mode', () => {
    delete navigatorWithStandalone.standalone;
    stubMatchMedia(true);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('returns false when running in a normal browser tab', () => {
    delete navigatorWithStandalone.standalone;
    stubMatchMedia(false);
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('returns true via the iOS navigator.standalone flag without matchMedia', () => {
    navigatorWithStandalone.standalone = true;
    stubMatchMedia(false);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('falls back to false where matchMedia is unavailable', () => {
    delete navigatorWithStandalone.standalone;
    (globalThis as { matchMedia?: typeof matchMedia }).matchMedia = undefined;
    expect(isStandaloneDisplay()).toBe(false);
  });
});
