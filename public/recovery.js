/*
 * Pre-mount recovery escape hatch (issue #276).
 *
 * `resetServiceWorkerOnly()` in the app covers a bad build that still *renders*. This covers
 * the one that does not: a broken entry chunk, a failed `coi-bootstrap` interaction, anything
 * that kills the bundle before React — and therefore before the error boundary and Safe Mode —
 * ever mounts. The cache-first worker (src/sw.ts) then keeps serving that same broken shell on
 * every reload, so the user sees a white screen with no in-app way out and has to reach for
 * devtools or "clear site data" (which also destroys their inventory).
 *
 * This script is what breaks that loop. It is a plain classic script in `<head>`, loaded from
 * the precache just like the shell, so it runs even when the module bundle is dead. Visiting
 *
 *     <app url>?recover=1
 *
 * unregisters every service worker, empties Cache Storage, and reloads onto the network copy.
 * It touches **no user data** — the OPFS database, the images directory, IndexedDB and
 * `localStorage` are all left alone.
 *
 * It lives in a separate `'self'` file rather than an inline <script> so the Content-Security-
 * Policy can forbid inline script entirely — see src/csp.ts, and public/coi-bootstrap.js which
 * is here for the same reason.
 *
 * The styles below are self-contained inline literals rather than design tokens — the same
 * documented exception the `.gb-fallback` guide in index.html takes, and for the same reason:
 * when the bundle is broken the token stylesheet may never have loaded, so this has to carry
 * its own appearance.
 */
(function () {
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  if (!params.has('recover')) return;

  /* Where to land afterwards: the same page with `recover` stripped, so the reload cannot
     re-trigger this and spin. */
  params.delete('recover');
  var query = params.toString();
  var target = window.location.pathname + (query ? '?' + query : '') + window.location.hash;

  /*
   * Start clearing *now*, without waiting for the DOM. This script runs from <head> while the
   * parser is still mid-document, so writing to `document.documentElement` here would
   * invalidate the parser's insertion point and leave the remaining markup appended after
   * whatever we wrote. The clearing is what matters; the message below is cosmetic and waits
   * for a safe moment.
   */
  var cleared = clearShell();

  /* Paint over the (possibly broken) page once the parser has finished with it. If the clearing
     wins the race the redirect simply happens first, which is the better outcome anyway. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showMessage, { once: true });
  } else {
    showMessage();
  }

  cleared.then(function () {
    var status = document.getElementById('gb-recovery-status');
    if (status) status.textContent = 'Done — reloading the latest version…';
    /* `replace` so the recovery URL never enters history: a Back press must not re-run it. */
    window.location.replace(target);
  });

  function showMessage() {
    if (!document.body) return;
    document.title = 'Recovering Gubbins';
    document.body.setAttribute(
      'style',
      'margin:0;background:#0b0b0f;color:#e8e8ee;' +
        'font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif',
    );
    document.body.innerHTML =
      '<main style="max-width:34rem;margin:0 auto;padding:3rem 1.5rem">' +
      '<h1 style="font-size:1.25rem;margin:0 0 .75rem">Recovering Gubbins&hellip;</h1>' +
      '<p id="gb-recovery-status" role="status" style="margin:0;color:#a5a5b4">' +
      'Clearing the cached app files. Your inventory, photos and settings are not touched.' +
      '</p></main>';
  }

  /*
   * Unregister every worker, then empty Cache Storage. The order matters: a still-registered
   * worker can repopulate a cache we have just deleted, so it has to go first. Each step is
   * independently fault-tolerant — a browser that refuses one must still get the other done,
   * and a total failure must still land the user on a normal page rather than stranding them
   * on this one.
   */
  function clearShell() {
    return settle(unregisterWorkers()).then(function () {
      return settle(deleteCaches());
    });
  }

  function settle(promise) {
    return promise.catch(function () {});
  }

  function unregisterWorkers() {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) {
        return Promise.resolve();
      }
      return navigator.serviceWorker.getRegistrations().then(function (registrations) {
        return Promise.all(
          registrations.map(function (registration) {
            return registration.unregister();
          }),
        );
      });
    } catch {
      return Promise.resolve();
    }
  }

  function deleteCaches() {
    try {
      if (!window.caches) return Promise.resolve();
      return caches.keys().then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            return caches.delete(key);
          }),
        );
      });
    } catch {
      return Promise.resolve();
    }
  }
})();
