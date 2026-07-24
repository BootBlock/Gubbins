/**
 * useReportWriteFailure — report a failed write to the user as a danger toast (issues #307, #389).
 *
 * A write that fails and says nothing is indistinguishable from doing nothing: an optimistic patch
 * that silently reverts reads as a UI glitch (#307), and a non-optimistic write that simply doesn't
 * apply reads as an unresponsive control (#389). Either way the write is failing for a reason worth
 * showing — a constraint violation, the storage hard stop, `SQLITE_BUSY` — and the rational response
 * is to retry a write that will keep failing. This reporter lives in the mutation hook's `onError`,
 * beside the write it explains, so a `.mutate()` with no `onError` of its own still tells the user;
 * a call site that wants more specific copy can still add its own `onError`, but no longer has to.
 *
 * The toast body comes from {@link useErrorMessage} (issue #311): a `DbError` carries the
 * **unmodified** SQLite text, so passing its message through would show `UNIQUE constraint failed:
 * tags.name` where a real sentence was derivable. The resolver humanises what it can from the stable
 * `code`, keeps a repository's authored sentence where there is one, and degrades to the call site's
 * `fallbackKey` otherwise. The default fallback is the optimistic "…has been undone" line; a
 * non-optimistic write, where nothing was undone, passes its own "…could not be saved" key.
 */
import { useCallback, useRef } from 'react';
// Imported from the subpath, not the `@/components/foundry` barrel: the barrel re-exports
// components that import back into feature modules (Modal/Menu/Markdown/RegionCanvas), so the
// barrel would drag those into every chunk that reports a write failure.
import { useOptionalToast } from '@/components/foundry/toast';
import { useT, type MessageKey } from '@/features/i18n';
import { useErrorMessage } from './useErrorMessage';

/**
 * A `*.writeError.heading.*` catalog key — the toast heading naming the verb that failed. Derived
 * from the catalog rather than hand-listed, so a new heading is one `en.json`/`de.json` key.
 */
export type WriteFailureHeadingKey = Extract<MessageKey, `${string}.writeError.heading.${string}`>;

/**
 * How long an identical failure is swallowed before it is reported again. Roughly a toast's own
 * dwell time, so a rapid burst of the same failure (repeated ± taps, a held key) reads as one
 * message rather than a stack — and announces once, not once per attempt, to assistive tech.
 */
const WRITE_FAILURE_REPEAT_MS = 3_000;

/**
 * Build an `onError` handler that reports a failed write to the user.
 *
 * @param headingKey  the toast heading naming what failed (`…writeError.heading.<verb>`).
 * @param fallbackKey the generic body shown when the error can't be humanised into a sentence;
 *                    defaults to the optimistic "your change has been undone" line.
 */
export function useReportWriteFailure(
  headingKey: WriteFailureHeadingKey,
  fallbackKey: MessageKey = 'inventory.writeError.reverted',
): (error: unknown) => void {
  // Optional: these hooks are exercised by harnesses that render without a ToastProvider, and a
  // failed write must not become a crash on top of a failed write.
  const toast = useOptionalToast();
  const t = useT();
  const describeError = useErrorMessage();
  // The last failure this hook instance reported, so a burst coalesces (see below).
  const lastReport = useRef<{ signature: string; at: number } | null>(null);
  return useCallback(
    (error: unknown) => {
      const detail = describeError(error, t(fallbackKey));
      const signature = `${headingKey} ${detail}`;
      const now = Date.now();

      // Report the first failure, then swallow identical repeats for a short window. The window is
      // deliberately not extended on a swallowed repeat, so an ongoing problem re-surfaces rather
      // than going quiet after one message.
      const last = lastReport.current;
      if (last && last.signature === signature && now - last.at < WRITE_FAILURE_REPEAT_MS) return;
      lastReport.current = { signature, at: now };

      toast?.show({ tone: 'danger', heading: t(headingKey), message: detail });
    },
    [toast, t, headingKey, fallbackKey, describeError],
  );
}
