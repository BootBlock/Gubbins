/**
 * usePwaUpdate — detect when a newer build of the PWA has installed in the background
 * and is *waiting* to take over, so the app can offer a "Reload now" affordance
 * (spec §2 installable/offline-first PWA).
 *
 * Gubbins ships with `registerType: 'prompt'` (see vite.config.ts): a new service
 * worker installs but never activates on its own, so a deploy can't reload the page
 * mid-session and discard the user's unsaved, in-flight work. This hook exposes that
 * "a new version is ready" signal (`needRefresh`) plus an `update()` that hands control
 * to the waiting worker — which then reloads the page onto the new version. Nothing
 * happens until the user explicitly calls `update()`.
 *
 * The service-worker registration goes through an injectable {@link PwaUpdateApi} seam
 * (the `useInstallPrompt` / `useOnlineStatus` `apiOverride` pattern) so the hook is
 * component-testable with a fake — no real browser, no real service worker. The real
 * seam pulls in `virtual:pwa-register` via a dynamic import, so the vite-plugin-pwa
 * virtual module is never evaluated in non-browser (test) environments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Callbacks the seam invokes for service-worker lifecycle transitions we surface. */
export interface PwaUpdateHandlers {
  /** A new worker has installed and is waiting — a refresh is available. */
  onNeedRefresh(): void;
}

/** Applies the waiting worker and reloads the page onto it. */
export type PwaUpdater = (reloadPage?: boolean) => Promise<void>;

/** Injectable seam over service-worker registration + the update handshake. */
export interface PwaUpdateApi {
  /**
   * Register the service worker and subscribe to update events. Returns the updater
   * that, when called, tells the waiting worker to take over (triggering a reload).
   */
  register(handlers: PwaUpdateHandlers): PwaUpdater;
}

/**
 * The real browser seam, backed by vite-plugin-pwa's `registerSW`. The virtual module
 * is loaded lazily (dynamic import) so it is only resolved in a real browser build —
 * tests use a fake `apiOverride` and never reach this code path.
 */
export function browserPwaUpdateApi(): PwaUpdateApi {
  return {
    register(handlers) {
      let updateSW: PwaUpdater | undefined;
      void import('virtual:pwa-register').then(({ registerSW }) => {
        // `immediate` registers without waiting for the window `load` event; the new
        // worker still only *activates* when `updateSW()` posts SKIP_WAITING.
        updateSW = registerSW({ immediate: true, onNeedRefresh: handlers.onNeedRefresh });
      });
      // `onNeedRefresh` only fires after registration completes (so `updateSW` is set by
      // the time the prompt is visible); guard anyway in case of an early call.
      return async (reloadPage = true) => {
        await updateSW?.(reloadPage);
      };
    },
  };
}

export interface PwaUpdateState {
  /** A newer version has installed and is waiting — show the "Reload now" prompt. */
  readonly needRefresh: boolean;
  /** Activate the waiting worker and reload the page onto the new version. */
  update: PwaUpdater;
}

/**
 * Track whether a new app version is waiting to be applied. Pass a fake `apiOverride`
 * in tests; production callers use the default browser seam.
 */
export function usePwaUpdate(apiOverride?: PwaUpdateApi): PwaUpdateState {
  // Resolve the seam once (per override identity) so the effect deps stay stable.
  const api = useMemo(() => apiOverride ?? browserPwaUpdateApi(), [apiOverride]);
  const [needRefresh, setNeedRefresh] = useState(false);
  const updaterRef = useRef<PwaUpdater | null>(null);
  // Register exactly once even under StrictMode's double-invoke (the ref instance
  // survives the simulated unmount/remount), so the worker isn't registered twice.
  const registeredRef = useRef(false);

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;
    updaterRef.current = api.register({ onNeedRefresh: () => setNeedRefresh(true) });
  }, [api]);

  const update = useCallback<PwaUpdater>(async (reloadPage = true) => {
    await updaterRef.current?.(reloadPage);
  }, []);

  return { needRefresh, update };
}
