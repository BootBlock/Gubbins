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
