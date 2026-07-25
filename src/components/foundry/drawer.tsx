import { type ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Surface } from './surface';
import { CloseButton } from './close-button';
import { useDialogBehaviour } from './use-dialog-behaviour';
import { useReducedMotion } from './useReducedMotion';

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The drawer's heading — rendered as its `<h2>` and used as the dialog's accessible name. */
  readonly title: string;
  readonly children: ReactNode;
  /** Extra classes merged onto the sliding panel (e.g. a wider `w-*` for a roomier list). */
  readonly className?: string;
}

/**
 * Foundry Drawer — an off-canvas panel that slides in from the left edge (spec §2.4.1, §3).
 *
 * The counterpart to {@link Modal} for content that is *navigation* rather than a task: on a
 * compact viewport the master-detail screens (Inventory, Projects) can't afford to spend 256px
 * of a 390px phone on a permanently-parked master pane, so that pane moves in here and is one
 * tap away instead. Nothing is hidden — this is reflow (WCAG 1.4.10), not a small-screen
 * feature cull — which is why the switch is a plain width test (see `COMPACT_LAYOUT_QUERY`).
 *
 * It is modal on purpose. The panel overlays the content it filters, so leaving the page behind
 * it interactive would let a tap land on a card the drawer is covering; `useDialogBehaviour`
 * gives it the identical `aria-modal` contract as `Modal` — modal-stack arbitration, initial
 * focus, Tab trap, Escape, scroll lock and focus restore — so a dialog opened *from* the
 * drawer (add/edit location) stacks correctly on top of it.
 *
 * The panel is capped at `85vw` so a strip of backdrop always remains: on a phone that strip is
 * the tap target that dismisses it, which is the gesture users reach for before hunting a close
 * button. The close button is still there, and Escape still works, so no route in is exclusive
 * to one input method.
 */
export function Drawer({ open, onClose, title, children, className }: DrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Honour the user's reduced-motion preference (§3 / WCAG 2.3.3): with it set, the panel
  // simply appears rather than sliding. The global CSS catch-all would neutralise the
  // animation anyway; gating at source means no animation event fires at all.
  const reducedMotion = useReducedMotion();

  useDialogBehaviour(open, onClose, dialogRef);

  if (!open) return null;

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- the backdrop's click-to-dismiss is a redundant pointer affordance; keyboard users dismiss via Escape (handled by useDialogBehaviour) or the Close button, so no keyboard handler belongs on this decorative overlay. */}
      <div
        className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm', !reducedMotion && 'animate-fade-in')}
        onClick={onClose}
      />
      <Surface
        className={cn(
          // Flush to the left edge and the full height of the fixed parent, so only the inner
          // corners are rounded. `85vw` is what keeps a strip of backdrop tappable at any width.
          'absolute inset-y-0 left-0 z-10 flex w-[min(20rem,85vw)] flex-col gap-3 rounded-l-none p-4',
          !reducedMotion && 'animate-drawer-in',
          className,
        )}
      >
        {/* A step below Modal's `text-lg` title: the panel is a third the width of a dialog, and
            a list's name doesn't need to shout over the list itself. */}
        <div className="flex shrink-0 items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        {/* The panel is the viewport's full height, so this region is the drawer's scroll area:
            `min-h-0` lets it shrink below its content height instead of pushing the panel past
            the bottom of the screen, and `dialog-scroll` bleeds the bar sideways into the
            Surface's own padding so it never paints over the content (classic or overlay bars).
            Content that manages its own inner scroller (the location tree) simply fills the
            region with `flex-1`, and this outer bar never appears. */}
        <div className="dialog-scroll flex min-h-0 flex-1 flex-col">{children}</div>
      </Surface>
    </div>,
    document.body,
  );
}
