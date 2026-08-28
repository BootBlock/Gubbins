/**
 * useDialogBehaviour — the shared `aria-modal` contract behind every Foundry dialog
 * surface (spec §3): {@link Modal} and {@link Drawer}.
 *
 * Both are modal dialogs that differ only in how they are painted — one is a centred panel,
 * the other slides in from the edge — so the behaviour they must get *exactly* right is
 * identical, and lives here once:
 *
 * - **Modal stack.** Dialogs open on top of one another (the "New location" dialog inside
 *   "Add item"; the same dialog opened from the locations drawer). Only the topmost may
 *   handle Escape/Tab, or one Escape would close the whole stack at once.
 * - **Initial focus.** On open, focus moves to the caller's chosen control when one is given
 *   (a type-first dialog is ready to type into), otherwise to the dialog container — the
 *   screen-reader-friendly default, where the dialog is announced via its `aria-label` and
 *   the first Tab steps into its controls rather than landing on Close.
 * - **Focus trap.** Tab cycles within the container while it is topmost.
 * - **Escape** closes.
 * - **The system Back gesture** closes (issue #590). An open dialog is a history entry, so on an
 *   installed PWA — where Back is the only back affordance there is — it dismisses the dialog
 *   instead of navigating the screen out from under it. See `dialog-history.ts`.
 * - **Scroll lock.** The body cannot scroll behind the dialog; the lock is shared, so
 *   dismissing a nested dialog keeps its parent's in place.
 * - **Focus restore.** On close, focus returns to whatever opened the dialog, so a keyboard
 *   user never loses their place.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { useDialogHistoryEntry } from './dialog-history';
import { nextTrapIndex, trapFocusables } from './focus-trap';
import { isTopModal, openModalCount, popModal, pushModal } from './modal-stack';

/**
 * Wire the modal contract above onto `containerRef` for as long as `open` is true.
 *
 * `onClose` and `initialFocusRef` are read through refs so call sites can keep passing inline
 * closures without re-running (and so re-trapping) the effect on every render — the effect
 * deliberately depends on `open` alone.
 *
 * @param containerRef The focusable (`tabIndex={-1}`) dialog container.
 * @param initialFocusRef Optional element to focus on open instead of the container.
 */
export function useDialogBehaviour(
  open: boolean,
  onClose: () => void,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;
  // The container ref object itself is stable for the component's lifetime, so reading it
  // through a ref keeps the effect's dependency list down to `open`.
  const containerRefRef = useRef(containerRef);
  containerRefRef.current = containerRef;

  // Back is a dismissal like any other, so it goes through the caller's own `onClose` — which for
  // a Modal is the request that consults the busy and unsaved-work guards first (issue #590).
  useDialogHistoryEntry(open, onClose);

  useEffect(() => {
    if (!open) return;
    const container = containerRefRef.current;
    const token = pushModal();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target = initialFocusRefRef.current?.current;
    if (target) target.focus();
    else container.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!isTopModal(token)) return;
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = container.current;
      if (!node) return;
      const focusables = trapFocusables(node);
      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? focusables.indexOf(active) : -1;
      const next = nextTrapIndex(focusables.length, currentIndex, e.shiftKey);
      e.preventDefault();
      if (next === null) node.focus();
      else focusables[next]?.focus();
    };

    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      popModal(token);
      if (openModalCount() === 0) document.body.style.overflow = '';
      // The dialog subtree is already detached here, so this lands on the opener.
      previouslyFocused?.focus?.();
    };
  }, [open]);
}
