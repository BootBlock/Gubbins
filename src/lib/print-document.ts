/**
 * Printing a self-contained HTML document, with an outcome the caller can act on (issue #510).
 *
 * The three label dialogs each built their sheet into a `window.open` popup and returned silently
 * when the browser handed back `null`. A popup blocker, a content blocker, an enterprise policy,
 * Safari's "Block Pop-ups" default or an installed PWA running `standalone` all produce that
 * `null`, so the user pressed **Print** and got nothing at all — no window, no error, no way to
 * tell a blocked popup from a broken button.
 *
 * This module prints into a **hidden same-document iframe** instead. No auxiliary window is
 * opened, so there is nothing for a popup blocker to refuse, and the frame's `load` event gives a
 * real moment to print at rather than racing the new document's layout. The frame prints its own
 * document, so the `@page` rules that size a die-cut label still apply.
 *
 * The popup remains only as a fallback for the narrow case where the frame cannot be driven at
 * all (no `contentWindow`, or `print()` throwing). That path can still be refused, and when it is
 * the caller is told `'blocked'` rather than left to guess.
 */

/** What {@link printHtmlDocument} was able to establish about the print it was asked for. */
export type PrintOutcome =
  /** The document was handed to the browser's print machinery. */
  | 'printed'
  /** Nothing could be printed — the browser refused every route open to us. */
  | 'blocked';

/**
 * How long to wait for the frame's `load` before printing anyway.
 *
 * Every document printed this way is self-contained — inline SVG and inline CSS, no network — so
 * a `load` that has not arrived by now was missed rather than pending, and printing is still the
 * right thing to do. Waiting forever would hang the button, which is the failure this fixes.
 */
const LOAD_TIMEOUT_MS = 3_000;

/**
 * How long the frame stays in the document when `afterprint` never fires.
 *
 * `print()` blocks until the dialog closes on most engines, but not all, and removing the frame
 * while its document is still being spooled loses the print. The window is generous because the
 * cost of keeping an empty 1px frame around is nothing next to the cost of a lost print.
 */
const FRAME_TTL_MS = 60_000;

/**
 * Print `html` as its own document, reporting whether anything could be printed.
 *
 * Resolves once the print has been *started*, which is as much as any browser will say: a user
 * who then cancels the print dialog is indistinguishable from one who prints, and neither is an
 * error. Only `'blocked'` means the user saw nothing happen.
 */
export async function printHtmlDocument(html: string): Promise<PrintOutcome> {
  const frame = document.createElement('iframe');
  // Off-screen rather than `display:none`: a frame that is not laid out has no pages to print.
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.srcdoc = html;

  const remove = () => frame.remove();

  try {
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    document.body.appendChild(frame);
    await loaded;

    const win = frame.contentWindow;
    if (!win || typeof win.print !== 'function') {
      remove();
      return printInPopup(html);
    }

    win.addEventListener('afterprint', remove, { once: true });
    setTimeout(remove, FRAME_TTL_MS);
    win.focus();
    win.print();
    return 'printed';
  } catch {
    remove();
    return printInPopup(html);
  }
}

/**
 * The original route, kept for the engines that cannot print a frame at all.
 *
 * This is the one that a popup blocker refuses, so its `null` is now reported rather than
 * swallowed.
 */
function printInPopup(html: string): PrintOutcome {
  try {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return 'blocked';
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    return 'printed';
  } catch {
    return 'blocked';
  }
}
