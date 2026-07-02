/**
 * A module-level LIFO registry of open {@link Modal}s, so dialogs can stack.
 *
 * Every Modal registers a token on open and releases it on close. Because each
 * Modal attaches its own document-level keydown listener, an Escape press (or a
 * Tab trap step) would otherwise be handled by *every* open dialog at once —
 * closing a parent underneath the nested dialog the user meant to dismiss. The
 * rule is simple: only the **topmost** modal responds to keyboard events, and
 * the shared `body` scroll lock is released only when the last modal closes.
 *
 * Pure bookkeeping (no DOM), split out of `modal.tsx` so the LIFO rules are
 * unit-testable in isolation (the `focus-trap.ts` seam pattern).
 */

const stack: symbol[] = [];

/** Register a newly-opened modal; returns the token it must release on close. */
export function pushModal(): symbol {
  const token = Symbol('modal');
  stack.push(token);
  return token;
}

/** Release a closing modal's token (safe to call with an already-released token). */
export function popModal(token: symbol): void {
  const index = stack.indexOf(token);
  if (index >= 0) stack.splice(index, 1);
}

/** Whether this modal is the topmost — the only one that owns keyboard events. */
export function isTopModal(token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** How many modals are open (the `body` scroll lock is held while > 0). */
export function openModalCount(): number {
  return stack.length;
}
