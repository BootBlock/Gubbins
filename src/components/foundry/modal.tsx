import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/features/i18n';
import { Button } from './button';
import { Surface } from './surface';
import { CloseButton } from './close-button';
import { useBackdropDismiss } from './backdrop-dismiss';
import { useDialogBehaviour } from './use-dialog-behaviour';
import { useReducedMotion } from './useReducedMotion';
import { UnsavedChangesContext, useUnsavedChangesRegistry } from './unsaved-changes';

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

/**
 * Ask before throwing away a draft (issue #576). Kept beside {@link Modal} rather than in its
 * own module because it *is* a Modal, and a separate file would put a cycle between the two.
 *
 * Its copy is the one part of the dialog frame that goes through `t()`, so the hook is called
 * here rather than in {@link Modal} itself: this component mounts only once someone tries to
 * dismiss unsaved work, which keeps the plain dialog frame — the one the crash screen's rescue
 * actions are drawn in — free of any dependency on the message catalog being loadable.
 */
function UnsavedChangesPrompt({
  onKeepEditing,
  onDiscard,
}: {
  readonly onKeepEditing: () => void;
  readonly onDiscard: () => void;
}) {
  const t = useT();
  // Initial focus lands on the safe answer, so a reflex Enter keeps the work rather than
  // discarding it — the same reason the destructive button is second in the row.
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open
      // Escape and a backdrop tap are dismissals of the *question*, and the safe reading of
      // "go away" here is that the draft stays.
      onClose={onKeepEditing}
      title={t('dialog.unsaved.title')}
      description={t('dialog.unsaved.description')}
      className="max-w-md"
      initialFocusRef={keepEditingRef}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          ref={keepEditingRef}
          variant="ghost"
          onClick={onKeepEditing}
          data-testid="unsaved-keep-editing"
        >
          {t('dialog.unsaved.keepEditing')}
        </Button>
        <Button variant="destructive" onClick={onDiscard} data-testid="unsaved-discard">
          {t('dialog.unsaved.discard')}
        </Button>
      </div>
    </Modal>
  );
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

  // Unsaved-work guard (issue #576). Every editor mounted below reports through this registry,
  // so a dismissal that would throw a draft away asks first instead of taking the dialog down
  // silently. A dialog holding nothing that reports behaves exactly as it always did.
  const { hasUnsavedChanges, report } = useUnsavedChangesRegistry();
  const [confirmingClose, setConfirmingClose] = useState(false);
  // A dismissal the *user* asked for, as opposed to the caller setting `open` to false: only the
  // former is worth questioning, since the latter is usually the dialog's own work completing.
  const requestClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);
  // A dialog closed out from under the question (a save landing, a route change) must not come
  // back asking about a draft that is no longer on screen.
  useEffect(() => {
    if (!open) setConfirmingClose(false);
  }, [open]);

  // Accessible dialog behaviour (spec §3 — aria-modal contract): modal-stack registration,
  // initial focus, Tab trap, Escape, scroll lock and focus restore. Shared with {@link Drawer}.
  useDialogBehaviour(open, requestClose, dialogRef, initialFocusRef);

  // Tap-the-backdrop-to-close (#614). The handlers sit on the container rather than the
  // backdrop because that is where the browser dispatches the click of a tap that starts on
  // one and lifts on the other; the press decides whether it dismisses. See
  // `backdrop-dismiss.ts`. It is a redundant pointer affordance — keyboard users dismiss via
  // Escape (handled by `useDialogBehaviour`) or the Close button — so it carries no keyboard
  // handler of its own.
  const { backdropRef, containerProps } = useBackdropDismiss(requestClose);

  if (!open) return null;

  return createPortal(
    <>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="fixed inset-0 z-50 grid place-items-center p-4 outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        {...containerProps}
      >
        <div
          ref={backdropRef}
          className={cn('absolute inset-0 bg-black/60 backdrop-blur-sm', !reducedMotion && 'animate-fade-in')}
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
              <CloseButton onClick={requestClose} />
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
            <UnsavedChangesContext.Provider value={report}>{children}</UnsavedChangesContext.Provider>
          </div>
        </Surface>
      </div>
      {/* A sibling of the dialog rather than a child of it, in the React tree as well as the DOM:
          a portal still bubbles its events through the tree it was declared in, so nesting the
          question inside would route every click in it back through this dialog's own
          backdrop-dismiss handlers. It is outside the provider for the same kind of reason — the
          question is dialog chrome, with no draft of its own to report. */}
      {confirmingClose ? (
        <UnsavedChangesPrompt
          onKeepEditing={() => setConfirmingClose(false)}
          onDiscard={() => {
            setConfirmingClose(false);
            onClose();
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}
