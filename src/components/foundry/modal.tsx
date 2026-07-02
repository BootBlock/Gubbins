import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Surface } from './surface';
import { Button } from './button';
import { CloseIcon } from '@/components/icons';
import { FOCUSABLE_SELECTOR, nextTrapIndex } from './focus-trap';
import { isTopModal, openModalCount, popModal, pushModal } from './modal-stack';
import { useReducedMotion } from './useReducedMotion';

/**
 * Foundry Modal — a lightweight, accessible dialog (spec §2.4.1). Hand-built for
 * Phase 2; can be swapped for the shadcn Dialog primitive later without touching
 * call sites. Closes on Escape and backdrop click, with a satisfying entrance.
 */
export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Opt-in: move initial focus to this element on open, rather than the dialog
   * container. Use for a dialog whose first action is typing (e.g. a Name field) so the
   * user can begin immediately. When omitted, focus parks on the container (the
   * screen-reader-friendly default — the dialog is announced and the first Tab steps in).
   */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  initialFocusRef,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Honour the user's reduced-motion preference (§3 / WCAG 2.3.3): when set, the
  // dialog's decorative fade/zoom entrance is dropped (the global CSS catch-all does
  // the same, but gating at source means no animation event fires at all).
  const reducedMotion = useReducedMotion();
  // Latest onClose without re-running the focus effect (call sites pass inline
  // closures that change every render — see the [open]-only dependency below).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Same treatment for the optional initial-focus target: read it at open time without
  // making it a dependency of the [open]-only focus effect.
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;

  // Accessible dialog behaviour (spec §3 — aria-modal contract): on open, move
  // focus into the dialog; while open, trap Tab within it and close on Escape;
  // on close/unmount, restore focus to whatever was focused before it opened.
  useEffect(() => {
    if (!open) return;
    // Register on the modal stack: dialogs can open on top of one another (e.g. the
    // "New location" dialog nested inside "Add item"), and only the topmost may
    // handle Escape/Tab — otherwise one Escape would close every open dialog at once.
    const token = pushModal();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move initial focus to the caller's chosen control (e.g. a Name field) when one is
    // given, so a type-first dialog is ready to type into; otherwise park focus on the
    // dialog container so screen readers announce the dialog (via aria-label) and the
    // first Tab steps into its controls — rather than landing on the Close button.
    const target = initialFocusRefRef.current?.current;
    if (target) target.focus();
    else dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!isTopModal(token)) return;
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? focusables.indexOf(active) : -1;
      const next = nextTrapIndex(focusables.length, currentIndex, e.shiftKey);
      e.preventDefault();
      if (next === null) container.focus();
      else focusables[next]?.focus();
    };

    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      popModal(token);
      // The scroll lock is shared: release it only when the *last* open modal
      // closes, so dismissing a nested dialog keeps its parent's lock in place.
      if (openModalCount() === 0) document.body.style.overflow = '';
      // Return focus to the element that opened the dialog, so a keyboard user
      // never loses their place (the dialog subtree is already detached here).
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-center p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn(
          'absolute inset-0 bg-black/60 backdrop-blur-sm',
          !reducedMotion && 'animate-fade-in',
        )}
        onClick={onClose}
      />
      <Surface
        className={cn(
          'relative z-10 w-full max-w-lg p-6',
          !reducedMotion && 'animate-zoom-in',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <CloseIcon className="text-glyph-neutral" />
          </Button>
        </div>
        <div className="mt-5">{children}</div>
      </Surface>
    </div>,
    document.body,
  );
}
