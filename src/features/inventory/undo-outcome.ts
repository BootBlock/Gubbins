/**
 * The follow-up message an undo shows once the reversal lands (issue #131).
 *
 * It lives here, in its own module, for a wiring reason worth stating: the confirmation must be
 * reported from `useUndoItemChanges`'s **own** mutation options rather than from a
 * `mutate(plan, { onSuccess })` callback at the call site. React Query skips per-call callbacks
 * when the observing component has unmounted — and by the time an Undo is pressed the component
 * that offered it usually *has*: the Move dialog closed on success, and the card carrying the
 * "Remove" button left the list the moment the item did. The reversal would still be written and
 * the user would still be told nothing.
 *
 * `mutations.ts` therefore imports this, and `useUndoToast` imports `mutations.ts`. Keeping the
 * reporter out of both breaks the cycle those two would otherwise form.
 */
import { useCallback } from 'react';
// Imported from the subpath, not the `@/components/foundry` barrel — the barrel would drag
// Modal/Menu/Markdown back into every chunk that reports a write outcome (as
// `useReportWriteFailure` notes).
import { useOptionalToast } from '@/components/foundry/toast';
import { useT } from '@/features/i18n';

/** How many items an undo put back, and how many it could not. */
export interface UndoOutcome {
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Build the handler that reports a completed reversal: how many items went back, or — when the
 * plan only partly applied — how many did not. A wholly-failed reversal never reaches here; it
 * rejects, and `useReportWriteFailure` explains why.
 *
 * The toast surface is optional so a harness rendering these hooks without a `ToastProvider`
 * stays silent rather than crashing on a write that actually succeeded.
 */
export function useReportUndoOutcome(): (outcome: UndoOutcome) => void {
  const toast = useOptionalToast();
  const t = useT();
  return useCallback(
    ({ succeeded, failed }: UndoOutcome) => {
      toast?.show({
        tone: failed > 0 ? 'warning' : 'success',
        message:
          failed > 0
            ? t('inventory.undo.partial', { vars: { restored: succeeded, failed } })
            : t('inventory.undo.done', { vars: { count: succeeded } }),
      });
    },
    [toast, t],
  );
}
