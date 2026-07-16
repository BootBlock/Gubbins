import { useCallback, useEffect, useState } from 'react';

/**
 * Thin React wrapper over the browser Fullscreen API.
 *
 * Fullscreen is a document-level, user-gesture-driven mode: entering it stretches
 * the app to fill the whole display (hiding the browser chrome), which is handy for
 * a data-dense screen like the inventory. The API is imperative and event-driven —
 * `requestFullscreen()` / `exitFullscreen()` mutate a global, and the browser fires
 * `fullscreenchange` whenever the mode flips (including when the user leaves via the
 * Escape key or the OS, which no caller can intercept). This hook adapts that into a
 * declarative `isFullscreen` flag plus a `toggle`, so a menu item can both drive it
 * and reflect its real state.
 *
 * @returns
 *  - `supported` — whether the current browser exposes the Fullscreen API at all.
 *  - `isFullscreen` — true while the document is displayed fullscreen.
 *  - `toggle` — enter fullscreen if not already, otherwise exit. Requests are made
 *    against the document element so the entire app fills the screen.
 */
export function useFullscreen(): {
  supported: boolean;
  isFullscreen: boolean;
  toggle: () => void;
} {
  const supported = typeof document !== 'undefined' && Boolean(document.documentElement.requestFullscreen);

  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenElement),
  );

  // The mode can change without us asking (Escape, the OS, another element requesting
  // it), so track the browser's own event as the single source of truth rather than
  // assuming our request/exit call succeeded.
  useEffect(() => {
    if (!supported) return;
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [supported]);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (document.fullscreenElement) {
      // Both calls return promises that can reject (e.g. the gesture was consumed or
      // the browser refused). There is nothing actionable to do on failure — the flag
      // stays in sync via `fullscreenchange` regardless — so swallow the rejection to
      // avoid an unhandled-promise console error.
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, [supported]);

  return { supported, isFullscreen, toggle };
}
