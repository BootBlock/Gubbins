/**
 * Unsaved-changes reporting — how an editor tells the dialog frame around it that it is holding
 * work nobody has written yet (issue #576).
 *
 * A Gubbins facet editor keeps its draft in local state and commits it on an explicit **Save**
 * press. That draft is invisible from the outside, so the frame had no way to tell a dismissal
 * that costs nothing from one that throws away a re-typed description — and Escape, a backdrop
 * tap and the Close button all discarded it without a word.
 *
 * This is the seam that closes that gap, deliberately kept to the smallest possible contract:
 *
 * - An editor calls {@link useReportUnsavedChanges} with the same `dirty` flag its Save button
 *   is already driven by. No editor has to know what the frame does with the answer.
 * - A frame calls {@link useUnsavedChangesRegistry} and publishes the returned `report` through
 *   {@link UnsavedChangesContext}. {@link import('./modal').Modal} does this for every dialog in
 *   the app, so an editor that reports gets the guard wherever it is mounted.
 *
 * Reporting is keyed per editor instance, so several editors on screen at once each speak only
 * for themselves — the frame is dirty while *any* of them is. Registration is by identity rather
 * than by name so two instances of the same editor never collide.
 *
 * Outside a provider the hook is a no-op: an editor rendered on a plain screen (or in a
 * {@link import('./drawer').Drawer}, which has no such guard) reports into nothing rather than
 * throwing, so the call site is safe to add unconditionally.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

/** Tell the frame whether the editor identified by `id` is currently holding unsaved work. */
export type ReportUnsavedChanges = (id: symbol, unsaved: boolean) => void;

/**
 * The reporting channel a dialog frame publishes for the editors inside it. `null` when there is
 * no frame listening, which is what makes {@link useReportUnsavedChanges} a safe no-op.
 */
export const UnsavedChangesContext = createContext<ReportUnsavedChanges | null>(null);

/** Shared empty set, so the initial state is one allocation rather than one per mounted frame. */
const NOTHING_UNSAVED: ReadonlySet<symbol> = new Set<symbol>();

export interface UnsavedChangesRegistry {
  /** Whether any editor below this frame is currently holding unsaved work. */
  readonly hasUnsavedChanges: boolean;
  /** Publish through {@link UnsavedChangesContext} so editors below can report. */
  readonly report: ReportUnsavedChanges;
}

/**
 * Frame side of the seam: collect what the editors below report, and answer whether anything is
 * unsaved. `report` is stable for the frame's lifetime, so publishing it never re-renders the
 * subtree that consumes it.
 */
export function useUnsavedChangesRegistry(): UnsavedChangesRegistry {
  const [unsavedIds, setUnsavedIds] = useState<ReadonlySet<symbol>>(NOTHING_UNSAVED);

  const report = useCallback<ReportUnsavedChanges>((id, unsaved) => {
    setUnsavedIds((previous) => {
      // Re-reporting what we already hold must return the same set: an editor reports on every
      // change of its `dirty` flag, and a fresh Set each time would re-render the whole frame
      // for a keystroke that changed nothing.
      if (previous.has(id) === unsaved) return previous;
      const next = new Set(previous);
      if (unsaved) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return { hasUnsavedChanges: unsavedIds.size > 0, report };
}

/**
 * Editor side of the seam: report whether this editor is holding unsaved work, so the dialog
 * around it can offer to keep it rather than discarding it on a dismissal.
 *
 * Pass the flag the editor's own Save button is driven by — the two must agree, or the dialog
 * would guard work the editor says is already saved (or wave through work it does not).
 */
export function useReportUnsavedChanges(unsaved: boolean): void {
  const report = useContext(UnsavedChangesContext);
  // One identity per mounted editor, minted lazily so it survives every re-render without a
  // dependency of its own. `useRef` rather than `useId`, because this is never rendered.
  const idRef = useRef<symbol | null>(null);
  idRef.current ??= Symbol('unsaved-changes');
  const id = idRef.current;

  // A *layout* effect, not a passive one, and that is load-bearing rather than stylistic: this
  // must land in the same commit as the keystroke that made the draft dirty. A passive effect is
  // scheduled after paint, so the very next event — Escape pressed straight after the last
  // character — is handled while the frame still believes there is nothing to lose, and the
  // dialog closes silently. That is the exact failure this seam exists to stop, so the report
  // runs synchronously before the browser can deliver another event.
  useLayoutEffect(() => {
    report?.(id, unsaved);
  }, [report, id, unsaved]);

  // Retract on unmount, separately from the report above so an ordinary dirty→clean change does
  // not churn the frame's state through a false. An editor that goes away is no longer holding
  // anything, whether it saved first or was torn down with the dialog.
  useLayoutEffect(() => () => report?.(id, false), [report, id]);
}
