/**
 * input-modality — "was the most recent input a pointer press or a keypress?", tracked once for
 * the whole document.
 *
 * This is a single global fact, and every consumer asks the same question of the same two
 * capture-phase document listeners. Tracking it per component looked harmless while `Tooltip` was
 * the only consumer, but a tooltip is a *leaf*: the Inventory list carries several per item card,
 * so a screenful installed and removed dozens of identical document listeners, and did it again on
 * every scroll recycle (issue #419). One refcounted subscription replaces all of them.
 *
 * Capture phase matters: the listener has to see the input wherever it lands, including a
 * click or tap that opens a dialog, so that the focus restored when the dialog closes is still
 * recognised as pointer-driven (issue #474).
 *
 * `false` (keyboard) is the resting default, so a trigger focused by keyboard immediately after
 * mount — before any input has been seen — is treated as the keyboard focus it is.
 */

let pointerInput = false;
let subscribers = 0;

const markPointer = () => {
  pointerInput = true;
};
const markKeyboard = () => {
  pointerInput = false;
};

/** Whether the most recent global input was a pointer press rather than a keypress. */
export function lastInputWasPointer(): boolean {
  return pointerInput;
}

/**
 * Start observing input modality, returning the matching unsubscribe. The listeners are installed
 * on the first subscriber and removed with the last, so a page with no consumer mounted carries
 * nothing. Safe to call outside a browser.
 */
export function observeInputModality(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (subscribers === 0) {
    document.addEventListener('pointerdown', markPointer, true);
    document.addEventListener('keydown', markKeyboard, true);
  }
  subscribers++;
  let released = false;
  return () => {
    // Guard against a double release (React 19 StrictMode remounts effects) miscounting the refs
    // and tearing the listeners down while other consumers are still mounted.
    if (released) return;
    released = true;
    subscribers--;
    if (subscribers === 0) {
      document.removeEventListener('pointerdown', markPointer, true);
      document.removeEventListener('keydown', markKeyboard, true);
      // Nothing is watching, so the last-seen modality is stale by the time anything asks again.
      pointerInput = false;
    }
  };
}
