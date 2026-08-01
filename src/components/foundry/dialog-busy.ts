/**
 * In-flight reporting — how a dialog tells the frame around it that it has started work which
 * cannot be interrupted, so a dismissal is refused rather than obeyed (issue #654).
 *
 * A dialog that kicks off a long, non-cancellable operation already disables its own buttons
 * while the work is in flight — but Escape, a backdrop tap and the ✕ never consulted that flag.
 * The dialog unmounted, the promise chain carried on, and every state setter that was going to
 * report the outcome landed on a component that no longer existed: a restore that erased and
 * replaced the database anyway, an import whose per-row report (including *why* rows were
 * skipped) was thrown away silently.
 *
 * This is the seam that closes that gap. It is deliberately the same shape as its neighbour
 * {@link import('./unsaved-changes')}, and the two answer a dismissal differently on purpose:
 *
 * - **Unsaved work** is the user's to weigh, so the frame *asks* and takes "discard" for an
 *   answer.
 * - **Work in flight** is not, so the frame *refuses*. There is nothing to weigh — closing the
 *   dialog would not stop the operation, only hide its outcome — so the honest answer is "not
 *   until this finishes", and busy is checked first where a dialog is both.
 *
 * Two ways in, because the flag sits in two different places across the app:
 *
 * - A dialog that renders its own {@link import('./modal').Modal} passes `busy` as a prop — it
 *   already holds the flag its buttons are disabled by, and a prop keeps that visible at the
 *   call site.
 * - A dialog whose flag lives in a *descendant* of the `Modal` (the restore panel inside Backup
 *   & restore, the workbench inside Import items, the count body two levels below the cycle-count
 *   dialog) calls {@link useReportDialogBusy} instead, and the frame collects it through
 *   {@link DialogBusyContext}. Lifting the flag through those trees would mean threading a
 *   callback purely to answer a question the frame is asking.
 *
 * Reporting is keyed per reporter instance, so several panels mounted at once each speak only
 * for themselves — the frame is busy while *any* of them is. Registration is by identity rather
 * than by name so two instances of the same panel never collide.
 *
 * Outside a provider the hook is a no-op: a panel rendered on a plain screen (or in a
 * {@link import('./drawer').Drawer}, which hosts navigation rather than tasks and so has no such
 * guard) reports into nothing rather than throwing, so the call site is safe to add
 * unconditionally.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

/** Tell the frame whether the panel identified by `id` currently has work in flight. */
export type ReportDialogBusy = (id: symbol, busy: boolean) => void;

/**
 * The reporting channel a dialog frame publishes for the panels inside it. `null` when there is
 * no frame listening, which is what makes {@link useReportDialogBusy} a safe no-op.
 */
export const DialogBusyContext = createContext<ReportDialogBusy | null>(null);

/**
 * The frame's answer, published back down for anything inside it that has to agree — read with
 * {@link useDialogIsBusy}. Separate from the reporting channel above so the reporting function
 * stays identity-stable: a panel's report must not re-fire every time the frame's answer changes.
 */
export const DialogBusyStateContext = createContext(false);

/** Shared empty set, so the initial state is one allocation rather than one per mounted frame. */
const NOTHING_BUSY: ReadonlySet<symbol> = new Set<symbol>();

export interface DialogBusyRegistry {
  /** Whether any panel below this frame currently has work in flight. */
  readonly isBusy: boolean;
  /** Publish through {@link DialogBusyContext} so panels below can report. */
  readonly report: ReportDialogBusy;
}

/**
 * Frame side of the seam: collect what the panels below report, and answer whether anything is
 * in flight. `report` is stable for the frame's lifetime, so publishing it never re-renders the
 * subtree that consumes it.
 */
export function useDialogBusyRegistry(): DialogBusyRegistry {
  const [busyIds, setBusyIds] = useState<ReadonlySet<symbol>>(NOTHING_BUSY);

  const report = useCallback<ReportDialogBusy>((id, busy) => {
    setBusyIds((previous) => {
      // Re-reporting what we already hold must return the same set: a panel reports on every
      // render, and a fresh Set each time would re-render the whole frame for a change of
      // nothing.
      if (previous.has(id) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return { isBusy: busyIds.size > 0, report };
}

/**
 * Panel side of the seam: report whether this panel has work in flight, so the dialog around it
 * refuses to be dismissed out from under it.
 *
 * Pass the same flag the panel's own buttons are disabled by — the two must agree, or the dialog
 * would hold the user in while its controls say the work is done (or let them out mid-write).
 */
export function useReportDialogBusy(busy: boolean): void {
  const report = useContext(DialogBusyContext);
  // One identity per mounted panel, minted lazily so it survives every re-render without a
  // dependency of its own. `useRef` rather than `useId`, because this is never rendered.
  const idRef = useRef<symbol | null>(null);
  idRef.current ??= Symbol('dialog-busy');
  const id = idRef.current;

  // A *layout* effect, not a passive one, for the same reason its unsaved-changes neighbour is:
  // this must land in the same commit as the render that started the work. A passive effect is
  // scheduled after paint, so an Escape pressed in the frame between the click and that paint is
  // handled while the frame still believes nothing is running — which is the exact failure this
  // seam exists to stop.
  useLayoutEffect(() => {
    report?.(id, busy);
  }, [report, id, busy]);

  // Retract on unmount, separately from the report above so an ordinary busy→idle change does
  // not churn the frame's state through a false. A panel that goes away is no longer holding the
  // frame open — and a frame the caller closed outright (`open` set to false) must not be left
  // believing it is still busy the next time it opens.
  useLayoutEffect(() => () => report?.(id, false), [report, id]);
}

/**
 * Whether the dialog frame around this subtree currently has work in flight.
 *
 * For a control *inside* a dialog that would take a panel down as surely as closing the dialog
 * would — the tab rail in Backup & restore, where switching tab unmounts the panel the work is
 * reporting into. Such a control is another way out, so it has to answer the question the same
 * way the frame does rather than keeping its own copy of the flag.
 *
 * Outside a frame this is simply `false`, so the call site is safe to add unconditionally.
 */
export function useDialogIsBusy(): boolean {
  return useContext(DialogBusyStateContext);
}
