/**
 * useErrorMessage — the React seam every dialog turns a thrown value into copy through (issue #311).
 *
 * Replaces the old idiom, `e instanceof Error ? e.message : 'Could not save.'`, which *preferred*
 * the raw SQLite text and only reached the written sentence when the thrown value was not an
 * `Error` — precisely backwards. The precedence here is:
 *
 *  1. A humanised sentence derived from the error's stable `code` ({@link describeDbError}).
 *  2. The error's own message, when it was authored for a human rather than emitted by SQLite.
 *  3. The call site's `fallback` — its context-specific copy.
 *
 * `fallback` is taken already-resolved (a `t(...)` call or, in the not-yet-converted screens, a
 * literal) so adopting this needs no i18n conversion of the surrounding dialog.
 */
import { useCallback } from 'react';
import { useT, type MessageKey } from '@/features/i18n';
import { describeDbError, hasAuthoredMessage } from './db-error-message';

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
      if (hasAuthoredMessage(error)) return error.message;
      return fallback;
    },
    [t],
  );
}
