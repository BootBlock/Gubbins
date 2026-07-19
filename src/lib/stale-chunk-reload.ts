/**
 * Recover a tab whose code chunks have gone missing under it (issue #279).
 *
 * Gubbins is code-split (`autoCodeSplitting`, vite.config.ts), so a screen's JavaScript is
 * fetched lazily the moment you first navigate to it. That fetch can fail for reasons that
 * have nothing to do with the code itself:
 *
 *  - **A second tab left behind by an update.** Updates are `prompt`-mode: a new worker waits
 *    until someone clicks "Reload now". The tab that clicks reloads onto the new build — but a
 *    *second* Gubbins tab keeps running the old JavaScript while the newly-activated worker has
 *    already dropped the old build's chunks from the precache (`sw.ts` `pruneStalePrecache`).
 *    The old hashed file is gone from the host too, so the next lazy import in that tab 404s.
 *  - **A half-propagated deploy**, where the shell is new but a chunk hasn't reached the CDN edge.
 *
 * In every case the tab is running code whose remaining pieces no longer exist, and the only
 * real cure is to load the current build — otherwise the screen simply never appears. So a
 * failed chunk load reloads the tab once, which fetches the current shell and the chunk names
 * that go with it.
 *
 * **Once per build, not once per tab.** The guard exists to stop a reload *loop*: if the reload
 * doesn't help — a genuinely broken deploy, or an offline tab with nothing cached to reload onto
 * — the tab comes back on the same build and would otherwise fail and reload forever. So the
 * marker records the {@link APP_VERSION} that reloaded, and a reload is allowed whenever the
 * running build differs from it. A recovery lands the tab on a *newer* build, so the next update
 * to strand this tab can recover too; a failed recovery lands it on the *same* build, so the
 * second failure surfaces through the error boundary instead. A flat once-per-tab marker would
 * stop the loop equally well but leave a long-lived tab (kiosk mode) unable to recover from any
 * update after the first.
 *
 * The failure signal is Vite's `vite:preloadError`, which it dispatches for every dynamic import
 * its preload helper handles (route chunks, lazy dialogs, the glyph picker). The event is left
 * un-cancelled on purpose: cancelling it makes the failed `import()` resolve to `undefined` and
 * the caller crash on the way out, whereas letting it throw means the error boundary can render
 * in the moment before the reload lands.
 *
 * The browser surface goes through an injectable {@link StaleChunkRecoveryApi} seam (the
 * `PwaUpdateApi` pattern) so the behaviour is unit-testable without a real reload.
 */
import { APP_VERSION } from './app-version';
import { STALE_CHUNK_RELOAD_KEY } from './storage-keys';

/** The browser bits this recovery touches, injectable so tests can observe them. */
export interface StaleChunkRecoveryApi {
  /** Has this tab already auto-reloaded while running the build it is running now? */
  hasRecovered(): boolean;
  /** Record that the running build is about to auto-reload, so a failed recovery can't loop. */
  markRecovered(): void;
  /** Reload the tab onto the currently deployed build. */
  reload(): void;
}

/**
 * The real browser seam. `sessionStorage` access is wrapped because it throws outright in a
 * partitioned/blocked-storage context; a tab that can't remember reloading is treated as having
 * already done so, which errs towards showing the error rather than risking a loop.
 */
export function browserStaleChunkRecoveryApi(): StaleChunkRecoveryApi {
  return {
    hasRecovered() {
      try {
        return sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) === APP_VERSION;
      } catch {
        return true;
      }
    },
    markRecovered() {
      try {
        sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, APP_VERSION);
      } catch {
        // Storage unavailable — `hasRecovered` already reports `true`, so nothing to record.
      }
    },
    reload() {
      window.location.reload();
    },
  };
}

/**
 * Subscribe to chunk-load failures and reload the tab (once) to recover. Called from `main.tsx`
 * before the app mounts, so a failure during the very first lazy route is already covered.
 * Returns an unsubscribe function for tests; production never needs it.
 */
export function installStaleChunkRecovery(
  api: StaleChunkRecoveryApi = browserStaleChunkRecoveryApi(),
): () => void {
  const onPreloadError = () => {
    if (api.hasRecovered()) return;
    api.markRecovered();
    api.reload();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
