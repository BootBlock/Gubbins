/**
 * useErrorMessage — the React seam every dialog turns a thrown value into copy through (issue #311).
 *
 * Replaces the old idiom, `e instanceof Error ? e.message : 'Could not save.'`, which *preferred*
 * the raw SQLite text and only reached the written sentence when the thrown value was not an
 * `Error` — precisely backwards. The precedence here is:
 *
 *  1. A humanised sentence derived from the error's stable `code` ({@link describeDbError}).
 *  2. A humanised sentence for a `fetch` transport failure ({@link describeNetworkError}).
 *  3. The error's own message, when it was authored for a human rather than emitted by SQLite.
 *  4. The call site's `fallback` — its context-specific copy.
 *
 * `fallback` is taken already-resolved (a `t(...)` call or, in the not-yet-converted screens, a
 * literal) so adopting this needs no i18n conversion of the surrounding dialog.
 *
 * Connectivity is read here rather than subscribed to: `isOnline()` is sampled at the moment the
 * failure is being described, which is the moment that matters. Using `useOnlineStatus` would
 * re-render every consumer of this seam — that is, most of the app — on every `online`/`offline`
 * event, to no benefit.
 */
import { useCallback } from 'react';
import { useT, type MessageKey } from '@/features/i18n';
import { isOnline } from '@/lib/env/network';
import { describeDbError, hasAuthoredMessage } from './db-error-message';
import { describeNetworkError } from './network-error-message';

/** Turns a thrown value plus the call site's own fallback copy into a user-facing sentence. */
export type ErrorMessageResolver = (error: unknown, fallback: string) => string;

export function useErrorMessage(): ErrorMessageResolver {
  const t = useT();
  return useCallback(
    (error: unknown, fallback: string) => {
      const described = describeDbError(error);
      if (described) {
        // The keys are asserted to exist in the base catalog by `db-error-message.test.ts`, which
        // is the check a cast cannot give us — the pure module stays catalog-free by design.
        const field = described.fieldKey ? t(described.fieldKey as MessageKey) : undefined;
        return t(described.key as MessageKey, field ? { vars: { field } } : undefined);
      }
      const network = describeNetworkError(error, isOnline());
      // Same guarantee as above: `network-error-message.test.ts` asserts these keys exist.
      if (network) return t(network.key as MessageKey);
      if (hasAuthoredMessage(error)) return error.message;
      return fallback;
    },
    [t],
  );
}
