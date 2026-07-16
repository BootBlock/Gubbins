/*
 * Cross-origin isolation bootstrap (spec §2.2.6).
 *
 * In production on a static host, the COOP/COEP headers the SQLite OPFS VFS needs are
 * supplied by the service worker (src/sw.ts). On the very first visit the page is not yet
 * isolated; once the worker takes control we reload exactly once so SharedArrayBuffer
 * becomes available. The dev server sets the headers directly, so this is a no-op locally.
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
  var KEY = 'gubbins-coi-reloaded';
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, '1');
      window.location.reload();
    }
  });
})();
