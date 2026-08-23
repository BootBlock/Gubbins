import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/features/i18n';
import { Button } from './button';
import { Surface } from './surface';
import { CloseButton } from './close-button';
import { LiveRegion } from './live-region';
import { useBackdropDismiss } from './backdrop-dismiss';
import { useDialogBehaviour } from './use-dialog-behaviour';
import { useReducedMotion } from './useReducedMotion';
import { UnsavedChangesContext, useUnsavedChangesRegistry } from './unsaved-changes';
import { DialogBusyContext, DialogBusyStateContext, useDialogBusyRegistry } from './dialog-busy';

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
  /**
   * Whether the dialog has work in flight that cannot be interrupted (issue #654). While set,
   * *every* route out is refused — Escape, a backdrop tap and the ✕ alike — and the ✕ is
   * disabled so the refusal is visible rather than a dead press.
   *
   * Pass the same flag the dialog's own buttons are disabled by. The frame owns the policy, so
   * this names the *reason* rather than the answer: a dialog can say it is working, and every
   * dismissal affordance then agrees on what that means. A dialog whose flag lives in a
   * descendant reports it with `useReportDialogBusy` instead; the two are OR'd, so a frame is
   * held while either says so.
   */
  readonly busy?: boolean;
}

/**
 * Say *why* a dismissal was refused, for a screen reader that would otherwise get silence
 * (WCAG 4.1.3). A separate component for the same reason {@link UnsavedChangesPrompt} is one:
 * it is the only other part of the dialog frame whose copy goes through `t()`, and it mounts
 * only once someone has actually tried to leave — so the plain frame, the one the crash screen
 * draws its rescue actions in, keeps no dependency on the message catalog being loadable.
 */
function DismissBlockedMessage() {
  const t = useT();
  return <p>{t('dialog.busy.blocked')}</p>;
}

/**
 * Ask before throwing away a draft (issue #576). Kept beside {@link Modal} rather than in its
 * own module because it *is* a Modal, and a separate file would put a cycle between the two.
 *
 * Its copy goes through `t()`, so the hook is called here rather than in {@link Modal} itself:
 * this component mounts only once someone tries to dismiss unsaved work, which keeps the plain
 * dialog frame — the one the crash screen's rescue actions are drawn in — free of any dependency
 * on the message catalog being loadable. {@link DismissBlockedMessage} is split out for the same
 * reason; between them they are the whole of the frame's translated copy.
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
  busy = false,
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

  // In-flight guard (issue #654). The same shape one level along: a panel below reports that it
  // has started work nobody can interrupt, and the frame refuses every route out until it ends.
  // OR'd with the caller's own `busy`, since the flag sits in the dialog itself as often as in a
  // panel below it.
  const { isBusy, report: reportBusy } = useDialogBusyRegistry();
  const blocked = busy || isBusy;
  // Counts refusals rather than flagging one, so a second Escape re-announces instead of
  // mutating the live region to the text it already holds — which several screen readers treat
  // as no change at all and say nothing about.
  const [refusals, setRefusals] = useState(0);

  // A dismissal the *user* asked for, as opposed to the caller setting `open` to false: only the
  // former is worth questioning, since the latter is usually the dialog's own work completing.
  const requestClose = useCallback(() => {
    // Busy is settled before unsaved work, because it is not a question. Offering to discard a
    // draft here would take an answer the frame cannot honour — closing does not stop the
    // operation, it only hides the outcome — so the honest reply is "not yet".
    if (blocked) {
      setRefusals((n) => n + 1);
      return;
    }
    if (hasUnsavedChanges) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [blocked, hasUnsavedChanges, onClose]);
  // A dialog closed out from under the question (a save landing, a route change) must not come
  // back asking about a draft that is no longer on screen.
  useEffect(() => {
    if (!open) setConfirmingClose(false);
  }, [open]);
  // The refusal count is scoped to a *spell* of work, not to the dialog being open: several
  // dialogs run one operation after another behind a single opening (each maintenance task, a
  // backup then a restore). Left standing, a count from the first spell would put the message
  // into the region at the instant the second one mounts it — announcing a refusal nobody made,
  // and inserting region and message together, which is the announcement loss this is shaped to
  // avoid.
  useEffect(() => {
    if (!blocked) setRefusals(0);
  }, [blocked]);

  // Keep focus inside the dialog when work starts. The controls that go busy are disabled in the
  // same commit — this frame's ✕ among them — and a browser blurs a focused element the moment
  // it is disabled, dropping focus to `<body>`: outside the dialog, outside its Tab trap, and
  // nowhere a screen reader can describe. Whatever the user had pressed, they end up back on the
  // container, which is where the dialog announces itself.
  useEffect(() => {
    if (!open || !blocked) return;
    const node = dialogRef.current;
    if (node && !node.contains(document.activeElement)) node.focus();
  }, [open, blocked]);

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
        className="fixed inset-0 z-50 grid place-items-center pt-safe-gutter-top pr-safe-gutter-right pb-safe-gutter-bottom pl-safe-gutter-left outline-none"
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
            // Cap the panel to the viewport (minus the frame's 1rem gutter top+bottom, and minus
            // whatever the device reserves at those edges — the `safe-dialog` token) and lay it out
            // as a flex column so the header stays pinned while the body scrolls — a tall dialog
            // (e.g. Edit location) no longer overflows the screen and strands its footer.
            // `dvh` tracks mobile browser chrome; caller `max-w-*` / `max-h-*` overrides still win
            // via tailwind-merge (see `cn`).
            'relative z-10 flex max-h-safe-dialog w-full max-w-lg flex-col p-6',
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
              {/* Disabled rather than merely inert while work is in flight: it is the one
                  dismissal affordance the user can *see*, so greying it out says "not yet"
                  before they press it, the same way the dialog's own buttons already do. */}
              <CloseButton onClick={requestClose} disabled={blocked} />
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

            `dialog-scroll` bleeds the *left* edge too, so the ring on a control sitting flush
            against that edge is not shaved off by the same `overflow-x: hidden` (issue #417).
            That lives in the utility rather than here, so every dialog scroll area gets it —
            including the ones the Modal does not own (a RailModal panel, a Drawer body). */}
          {/* `flex flex-col` (the `!scrollBody` case) is what lets a self-scrolling body *shrink*.
            Each such dialog sizes its own frame in viewport units — RailModal asks for `74dvh`,
            the preset picker `65vh` — and on a short viewport (a small laptop, or any display
            zoomed in, where the header and its description also wrap taller) that exceeds what the
            viewport-capped Surface can give it. As a plain block child it would simply spill out
            past the Surface with no way to reach the bottom of it; as a flex item it shrinks to
            the room actually left over and scrolls internally instead. */}
          <div className={cn('mt-5 min-h-0', scrollBody ? 'dialog-scroll' : 'flex flex-col')}>
            <UnsavedChangesContext.Provider value={report}>
              <DialogBusyContext.Provider value={reportBusy}>
                <DialogBusyStateContext.Provider value={blocked}>{children}</DialogBusyStateContext.Provider>
              </DialogBusyContext.Provider>
            </UnsavedChangesContext.Provider>
          </div>
          {/* Mounted for as long as the dialog is holding on, its *content* swapped in when a
              dismissal is actually turned down — a live region inserted at the same moment as its
              message is frequently never announced at all (see `live-region.tsx`), and going busy
              always precedes a refusal by at least one commit, so the region is there in good
              time. Tied to `blocked` rather than left up permanently so a dialog that never runs
              anything adds no second status region beside its own. Last inside the Surface, after
              the body, so it sits outside the scroll region rather than in the middle of it. */}
          {blocked ? (
            <LiveRegion visuallyHidden data-testid="dialog-dismiss-blocked">
              {refusals > 0 ? <DismissBlockedMessage key={refusals} /> : null}
            </LiveRegion>
          ) : null}
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
            // Re-checked rather than assumed: the question can only have been *opened* while
            // idle, but the work behind it need not have been started from this dialog — a
            // caller-owned mutation can go busy while it is up, and a "discard" answered then
            // must not be the one route out that still closes.
            if (blocked) {
              setRefusals((n) => n + 1);
              return;
            }
            onClose();
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}
