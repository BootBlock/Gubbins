import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Surface } from './surface';
import { CloseButton } from './close-button';
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
   * Optional element rendered in the header's top-right, just left of the close button — e.g. a
   * status pill or badge that belongs with the title rather than in the body. Omit for none.
   */
  readonly titleAccessory?: ReactNode;
  /**
   * Opt-in: move initial focus to this element on open, rather than the dialog
   * container. Use for a dialog whose first action is typing (e.g. a Name field) so the
   * user can begin immediately. When omitted, focus parks on the container (the
   * screen-reader-friendly default — the dialog is announced and the first Tab steps in).
   */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Whether the Modal owns the body's vertical scroll. Default `true`: the body region is the
   * dialog's single scroll area — it bleeds its scrollbar into the Surface's padding (via
   * `dialog-scroll`) so the bar never paints over content, on classic *or* overlay scrollbars.
   *
   * Set `false` for a dialog that manages its own inner scroll (e.g. a fixed-height rail with a
   * scrolling panel — {@link RailModal}, the Erase-data rail). The body then lays out at its
   * natural height with `overflow: visible`, so the inner scroller's own `dialog-scroll` bleed
   * has a clear path out to the Surface's padding instead of leaking a spurious horizontal bar
   * into an intermediate scroll container.
   */
  readonly scrollBody?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  titleAccessory,
  initialFocusRef,
  scrollBody = true,
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
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- the backdrop's click-to-dismiss is a redundant pointer affordance; keyboard users dismiss via Escape (handled in the effect above) or the Close button, so no keyboard handler belongs on this decorative overlay. */}
      <div
        className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm', !reducedMotion && 'animate-fade-in')}
        onClick={onClose}
      />
      <Surface
        className={cn(
          // Cap the panel to the viewport (minus the outer p-4 = 1rem top+bottom) and lay it
          // out as a flex column so the header stays pinned while the body scrolls — a tall
          // dialog (e.g. Edit location) no longer overflows the screen and strands its footer.
          // `dvh` tracks mobile browser chrome; caller `max-w-*` / `max-h-*` overrides still win
          // via tailwind-merge (see `cn`).
          'relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col p-6',
          !reducedMotion && 'animate-zoom-in',
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {titleAccessory}
            <CloseButton onClick={onClose} />
          </div>
        </div>
        {/* The body region. `min-h-0` lets this flex child shrink below its content height so a
            too-tall dialog scrolls rather than growing past the cap. By default it *is* the
            dialog's scroll area (`dialog-scroll`), which bleeds its scrollbar sideways into the
            Surface's own padding — so the bar (classic OR floating overlay) sits over that padding,
            never over the content, and content still aligns with the header. Because this region is
            a direct child of the padded Surface, that bleed has nowhere to leak. A dialog that owns
            its own inner scroller passes `scrollBody={false}`, leaving this region at `overflow:
            visible` so the inner bleed can reach the Surface padding too.

            `-ml-2 pl-2` bleeds the *left* edge the same way, but for a different reason: because
            `dialog-scroll` clips overflow (`overflow-x: hidden`), it would otherwise shave the
            focus/selection ring off a control sitting flush against the left edge — e.g. the
            leading "No colour"/"No type" swatch in the Add/Edit location dialog, whose selection
            ring is always drawn. The negative margin is cancelled by the equal padding, so no
            content shifts; it just gives an outward ring room to paint into the Surface's own
            padding. Paired with `dialog-scroll` so it only applies to the scroll-owning body. */}
        {/* `flex flex-col` (the `!scrollBody` case) is what lets a self-scrolling body *shrink*.
            Each such dialog sizes its own frame in viewport units — RailModal asks for `74dvh`,
            the preset picker `65vh` — and on a short viewport (a small laptop, or any display
            zoomed in, where the header and its description also wrap taller) that exceeds what the
            viewport-capped Surface can give it. As a plain block child it would simply spill out
            past the Surface with no way to reach the bottom of it; as a flex item it shrinks to
            the room actually left over and scrolls internally instead. */}
        <div className={cn('mt-5 min-h-0', scrollBody ? 'dialog-scroll -ml-2 pl-2' : 'flex flex-col')}>
          {children}
        </div>
      </Surface>
    </div>,
    document.body,
  );
}
