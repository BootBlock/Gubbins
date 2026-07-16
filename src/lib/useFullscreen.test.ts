import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useFullscreen } from './useFullscreen';

afterEach(cleanup);

/**
 * jsdom ships no Fullscreen API, so each test installs a small controllable fake on
 * `document`: a mutable `fullscreenElement`, request/exit that flip it and dispatch the
 * real `fullscreenchange` event the hook listens for, and the ability to omit
 * `requestFullscreen` entirely to simulate an unsupported browser.
 */
function installFullscreen({ supported = true }: { supported?: boolean } = {}) {
  let element: Element | null = null;

  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => element,
  });

  const requestFullscreen = vi.fn(async () => {
    element = document.documentElement;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  const exitFullscreen = vi.fn(async () => {
    element = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });

  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: supported ? requestFullscreen : undefined,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });

  return { requestFullscreen, exitFullscreen };
}

beforeEach(() => {
  installFullscreen();
});

afterEach(() => {
  // Reset back to a clean, "no fullscreen active" baseline between tests.
  installFullscreen();
});

describe('useFullscreen (issue #118)', () => {
  it('reports the API as supported and starts windowed', () => {
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.supported).toBe(true);
    expect(result.current.isFullscreen).toBe(false);
  });

  it('enters fullscreen and reflects the new state on toggle', () => {
    const { requestFullscreen } = installFullscreen();
    const { result } = renderHook(() => useFullscreen());

    act(() => result.current.toggle());

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.isFullscreen).toBe(true);
  });

  it('exits fullscreen when toggled while already fullscreen', () => {
    const { requestFullscreen, exitFullscreen } = installFullscreen();
    const { result } = renderHook(() => useFullscreen());

    act(() => result.current.toggle());
    expect(result.current.isFullscreen).toBe(true);

    act(() => result.current.toggle());
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.isFullscreen).toBe(false);
  });

  it('tracks an external exit (e.g. the Escape key) via fullscreenchange', () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.toggle());
    expect(result.current.isFullscreen).toBe(true);

    // The browser leaves fullscreen without going through our toggle.
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => null,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(result.current.isFullscreen).toBe(false);
  });

  it('reports unsupported and never calls the API when absent', () => {
    const { requestFullscreen } = installFullscreen({ supported: false });
    const { result } = renderHook(() => useFullscreen());

    expect(result.current.supported).toBe(false);
    act(() => result.current.toggle());
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});
