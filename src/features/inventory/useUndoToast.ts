/**
 * `useUndoToast` — the one place an inventory write offers to reverse itself (issue #131).
 *
 * A bulk edit, a remove or a move confirms itself with a toast; this hook attaches the "Undo"
 * action to that toast and replays the {@link UndoPlan} behind it. Keeping the wiring here means
 * every reversible write gets the same affordance and the same follow-up confirmation, rather
 * than three call sites each inventing their own. What the reversal *reports* belongs to the
 * mutation, not to this hook — see `undo-outcome.ts` for why.
 *
 * The toast *is* the announcement: its viewport is `aria-live`, so a screen-reader user hears the
 * outcome and can reach the Undo button. Call sites must therefore not also push the same
 * sentence into a `<LiveRegion>`, or it is announced twice.
 *
 * The toast surface is {@link useOptionalToast}, not `useToast`: this hook *reports the outcome
 * of a write* rather than being UI in its own right, so it follows `useReportWriteFailure` and
 * stays silent under a harness with no provider. A successful delete must not become a crash
 * because the confirmation had nowhere to go.
 */
import { useCallback } from 'react';
import { useOptionalToast, type ToastTone } from '@/components/foundry/toast';
import { useT } from '@/features/i18n';
import { useUndoItemChanges } from './mutations';
import { isUndoPlanEmpty, UNDO_TOAST_DURATION_MS, type UndoPlan } from './undo';

/**
 * Confirms a write with `message` and, when `plan` can restore anything, offers an Undo beside
 * it. An empty plan (nothing actually changed, or nothing to change it back to) shows the plain
 * confirmation — an Undo that would do nothing is worse than none.
 *
 * `tone` lets a caller downgrade the confirmation: a batch where some items would not apply is
 * a `warning`, not a success, even though the part that landed is still reversible.
 */
export function useUndoToast(): (message: string, plan: UndoPlan, tone?: ToastTone) => void {
  const toast = useOptionalToast();
  const t = useT();
  const undo = useUndoItemChanges();

  return useCallback(
    (message: string, plan: UndoPlan, tone: ToastTone = 'success') => {
      if (isUndoPlanEmpty(plan)) {
        // No action to reach for, so the length-derived dwell applies as it does to any other
        // passive confirmation — holding it for the full undo window would only be in the way.
        toast?.show({ tone, message });
        return;
      }
      toast?.show({
        tone,
        message,
        duration: UNDO_TOAST_DURATION_MS,
        // The reversal reports its own outcome, success or failure, from the mutation's
        // options — this component is usually gone by the time it lands (see `undo-outcome.ts`).
        action: { label: t('inventory.undo.action'), onClick: () => undo.mutate(plan) },
      });
    },
    [toast, t, undo],
  );
}
