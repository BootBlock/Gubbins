/**
 * Pure focus-trap maths for the Foundry Modal (spec §2.4.1 / §3 — accessible
 * dialogs). Kept DOM-free so the wrap-around Tab logic is unit-tested directly
 * (Protocol Beta), mirroring `list-window.ts` / `cycle-count.ts`. The DOM glue
 * (querying focusables, moving and restoring focus) lives in `modal.tsx`.
 */

/**
 * CSS selector for the elements a focus trap should cycle through. Disabled
 * controls and `tabindex="-1"` (programmatically-focusable-only) elements are
 * deliberately excluded so they are never reachable by Tab inside the dialog.
 *
 * The `tabindex="-1"` exclusion is applied to *every* clause, not just the bare
 * `[tabindex]` one: a natively-focusable element (`button`, `input`, …) that opts out
 * of the tab order with `tabindex="-1"` must be skipped too. This is what makes a roving
 * `role="radio"` group inside a dialog (its unchecked radios carry `tabindex="-1"`) count
 * as a single Tab stop rather than one stop per radio.
 */
export const FOCUSABLE_SELECTOR = ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]']
  .map((sel) => `${sel}:not([disabled]):not([tabindex="-1"])`)
  .join(',');

/**
 * Given the number of focusable elements in the dialog, the index of the one
 * that currently holds focus (`-1` when focus is on the dialog container or has
 * escaped the set), and whether Shift is held, return the index a trapped Tab
 * should move focus to — wrapping at both ends so focus never leaves the dialog.
 *
 * Returns `null` when there is nothing focusable, in which case the caller keeps
 * focus parked on the dialog container itself.
 */
export function nextTrapIndex(count: number, currentIndex: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (backwards) {
    return currentIndex <= 0 ? count - 1 : currentIndex - 1;
  }
  return currentIndex >= count - 1 ? 0 : currentIndex + 1;
}
