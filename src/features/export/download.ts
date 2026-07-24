/**
 * The single browser-download side-effect shared by every export path.
 *
 * Extracted so each export — the Export Wizard, the Reports CSV, and the project BOM
 * export (issue #27) — triggers a download exactly one way, never a hand-rolled copy.
 * Kept tiny and DOM-only so the pure builders stay free of side-effects.
 *
 * Two cross-browser hazards are avoided deliberately (issue #257):
 *  - The anchor is **appended to the document** before `click()`. A detached anchor's
 *    synthetic click is unreliable outside Chromium (Firefox in particular ignores it),
 *    so the export would silently do nothing.
 *  - The object URL is revoked on a **later task**, not synchronously after `click()`.
 *    Firefox starts fetching the blob asynchronously, so revoking immediately races the
 *    download and the file never appears (see Bugzilla 1282407). Deferring the revoke
 *    lets the fetch resolve first while still freeing the URL promptly.
 */
export function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Defer teardown so the browser can start resolving the blob before the URL is revoked.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(href);
  }, 0);
}
