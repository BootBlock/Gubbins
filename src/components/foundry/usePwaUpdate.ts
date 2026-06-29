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
 * `registerSW({ immediate: true })` only checks for a newer worker on navigation /
 * page-load, so a long-lived tab (e.g. Kiosk mode) would never notice a deploy. To
 * close that gap the hook actively re-checks the registration on a timer *and* whenever
 * the tab becomes visible again, via {@link PwaUpdateApi.checkForUpdate}.
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
  /** Re-check for a newer waiting worker; resolves when the browser check is done (no-op until the registration is ready). */
  checkForUpdate(): Promise<void>;
}

/**
 * The real browser seam, backed by vite-plugin-pwa's `registerSW`. The virtual module
 * is loaded lazily (dynamic import) so it is only resolved in a real browser build —
 * tests use a fake `apiOverride` and never reach this code path.
 */
export function browserPwaUpdateApi(): PwaUpdateApi {
  // The active registration, captured asynchronously via `onRegisteredSW`. Until it
  // arrives `checkForUpdate()` is a resolved no-op.
  let registration: ServiceWorkerRegistration | undefined;
  return {
    register(handlers) {
      let updateSW: PwaUpdater | undefined;
      void import('virtual:pwa-register').then(({ registerSW }) => {
        // `immediate` registers without waiting for the window `load` event; the new
        // worker still only *activates* when `updateSW()` posts SKIP_WAITING.
        updateSW = registerSW({
          immediate: true,
          onNeedRefresh: handlers.onNeedRefresh,
          // Capture the registration so the hook's periodic / visibility checks can
          // ask the browser to re-fetch the worker (`registration.update()`).
          onRegisteredSW: (_swUrl, reg) => {
            registration = reg;
          },
        });
      });
      // `onNeedRefresh` only fires after registration completes (so `updateSW` is set by
      // the time the prompt is visible); guard anyway in case of an early call.
      return async (reloadPage = true) => {
        await updateSW?.(reloadPage);
      };
    },
    async checkForUpdate() {
      // No-op until the registration has been captured; once it has, ask the browser to
      // re-fetch the worker script — a newer build surfaces via `onNeedRefresh`.
      await registration?.update();
    },
  };
}

export interface PwaUpdateState {
  /** A newer version has installed and is waiting — show the "Reload now" prompt. */
  readonly needRefresh: boolean;
  /** Increments on every waiting-worker notification, so a caller can re-surface a snoozed prompt when a genuinely new worker appears. */
  readonly updateAvailableSeq: number;
  /** Activate the waiting worker and reload the page onto the new version. */
  update: PwaUpdater;
}

/** Default cadence for the active "is there a newer worker?" check — once an hour. */
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Track whether a new app version is waiting to be applied. Pass a fake `apiOverride`
 * in tests; production callers use the default browser seam.
 *
 * Beyond the on-navigation check that `registerSW` performs, the hook actively polls
 * for a newer worker every `checkIntervalMs` (default one hour) and whenever the tab
 * returns to the foreground — so a long-lived/Kiosk tab still notices a deploy.
 */
export function usePwaUpdate(
  apiOverride?: PwaUpdateApi,
  checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): PwaUpdateState {
  // Resolve the seam once (per override identity) so the effect deps stay stable.
  const api = useMemo(() => apiOverride ?? browserPwaUpdateApi(), [apiOverride]);
  const [needRefresh, setNeedRefresh] = useState(false);
  // Ticks 1,2,3… on each waiting-worker notification (not just the first), so callers
  // can distinguish a brand-new worker from a prompt they've already snoozed.
  const [updateAvailableSeq, setUpdateAvailableSeq] = useState(0);
  const updaterRef = useRef<PwaUpdater | null>(null);
  // Register exactly once even under StrictMode's double-invoke (the ref instance
  // survives the simulated unmount/remount), so the worker isn't registered twice.
  const registeredRef = useRef(false);

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;
    updaterRef.current = api.register({
      onNeedRefresh: () => {
        setNeedRefresh(true);
        setUpdateAvailableSeq((seq) => seq + 1);
      },
    });
  }, [api]);

  // Actively re-check for a newer worker on a timer and when the tab regains focus.
  // Both paths swallow rejections so a failed check never throws into React.
  useEffect(() => {
    const check = () => {
      void api.checkForUpdate().catch(() => {});
    };
    const interval = setInterval(check, checkIntervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, checkIntervalMs]);

  const update = useCallback<PwaUpdater>(async (reloadPage = true) => {
    await updaterRef.current?.(reloadPage);
  }, []);

  return { needRefresh, updateAvailableSeq, update };
}
