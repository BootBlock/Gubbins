/*
 * Cross-origin isolation bootstrap (spec §2.2.6).
 *
 * In production on a static host, the COOP/COEP headers the SQLite OPFS VFS needs are
 * supplied by the service worker (src/sw.ts). On the very first visit the page is not yet
 * isolated; once the worker takes control we reload so SharedArrayBuffer becomes available.
 * The dev server sets the headers directly, so this is a no-op locally.
 *
 * This lives in a separate `'self'` file (not an inline <script>) so the Content-Security-
 * Policy can forbid inline script entirely — see src/csp.ts.
 */
(function () {
  /*
   * Announce that this script ran, before any early return below — the flag means only
   * "executed", never "isolation succeeded".
   *
   * Because this is a same-origin <script src> in <head>, it has necessarily run by the time
   * app code does. So if the app is running and this flag is missing, the script was removed
   * in transit — a content blocker, privacy extension, or filtering proxy. That is what lets
   * the boot screen say "something is blocking Gubbins" instead of libelling the browser as
   * unsupported. The name is duplicated as COI_BOOTSTRAP_MARKER in
   * src/lib/env/support-diagnosis.ts (a static asset cannot import it); a test pins the two
   * together, so rename both or neither.
   */
  window.__gubbinsCoiBootstrapRan = true;

  if (window.crossOriginIsolated) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  /*
   * How many reloads this session may spend chasing isolation (issue #260).
   *
   * The reload has to be capped, or an origin whose COOP/COEP headers are stripped in transit
   * would reload for ever. It must not be capped at *one*, though: a single attempt spent on a
   * navigation that did not come back isolated leaves the session with no way out but closing
   * the tab. Two is the smallest cap that survives one wasted attempt.
   *
   * A cap is all that is needed to stop a loop, because the only thing that schedules a reload
   * here is a *new* worker taking control — `controllerchange` does not fire again for a
   * controller that is already in place, so the stripped-headers case stops on its own after
   * the first attempt regardless of what is left in the budget.
   *
   * Exhausting the budget is no longer a dead end either: the boot gate watches for the same
   * event, and opens the database on the fallback VFS once a worker controls the page without
   * isolation arriving. See `useDatabaseBoot.ts`.
   */
  var KEY = 'gubbins-coi-reload-attempts';
  var MAX_ATTEMPTS = 2;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    var attempts = parseInt(sessionStorage.getItem(KEY), 10) || 0;
    if (attempts >= MAX_ATTEMPTS) return;
    sessionStorage.setItem(KEY, String(attempts + 1));
    window.location.reload();
  });
})();
