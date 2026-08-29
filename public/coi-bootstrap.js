/*
 * Cross-origin isolation bootstrap (spec §2.2.6).
 *
 * In production on a static host, the COOP/COEP headers the SQLite OPFS VFS needs are
 * supplied by the service worker (src/sw.ts). On the very first visit the page is not yet
 * isolated; once the worker takes control we reload — within a small per-session budget — so
 * SharedArrayBuffer becomes available. The dev server sets the headers directly, so this is a
 * no-op locally.
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
   * A budget of reloads for this session, rather than a single flag (issue #260).
   *
   * The count has to be capped, or an origin whose COOP/COEP headers are stripped in transit
   * could reload for ever. A cap of one, though, spends the session's only attempt on the first
   * controller change and has nothing left for a later one — and a later one is not exotic: a
   * navigation the worker did not intercept comes back uncontrolled, and the next worker to
   * claim that document fires this event again. Two costs a bounded extra reload in the case
   * that gains nothing, and buys a way out in the case that does.
   *
   * The budget is stored rather than held in a variable precisely because each attempt destroys
   * the document that counted it.
   *
   * Running out is not the dead end it was: the boot gate waits on the same event, and opens
   * the database on the fallback VFS once a worker controls the page without isolation
   * arriving. See `useDatabaseBoot.ts`.
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
