import { useState } from 'react';

export interface ProgressiveRevealOptions {
  /** How many rows are visible before the user asks for more. Must be at least 1. */
  readonly initial: number;
  /** How many further rows each "show more" reveals. Defaults to {@link initial}. */
  readonly step?: number;
}

export interface ProgressiveReveal {
  /** How many rows to render — never more than the total, never fewer than `initial`. */
  readonly limit: number;
  /** Whether rows remain beyond {@link limit} (i.e. the list is still a partial view). */
  readonly hasMore: boolean;
  /** Whether the user has revealed past the initial slice (i.e. collapsing is meaningful). */
  readonly expanded: boolean;
  /** Reveal the next `step` rows. */
  readonly showMore: () => void;
  /** Collapse back to the initial slice. */
  readonly showLess: () => void;
}

/**
 * Progressive reveal for a list that renders only the head of a set it holds in full (issue #609).
 *
 * A hard-coded `items.slice(0, N)` presents a sample as if it were the whole set; pairing this hook
 * with the {@link ./show-more.ShowMore} footer makes the slice honest — the footer says how much is
 * held back, and the reveal makes the rest reachable a chunk at a time. Revealing in steps rather
 * than all at once keeps the render bounded: these lists are unvirtualised, so a single "show all"
 * over a 10,000-row inventory would paint every row.
 *
 * The visible count is **reconciled on read** rather than stored: `limit` is always clamped to the
 * current total, so a refetch that shrinks the set (a narrower window, a deleted category) can
 * never leave the footer claiming rows that are no longer there.
 */
export function useProgressiveReveal(
  total: number,
  { initial, step = initial }: ProgressiveRevealOptions,
): ProgressiveReveal {
  const floor = Math.max(1, Math.floor(initial));
  const chunk = Math.max(1, Math.floor(step));
  const size = Math.max(0, Math.floor(total));
  const [requested, setRequested] = useState(floor);

  // Reconcile on read: the stored request is only ever a ceiling the user asked for — what is
  // actually rendered is that request clamped into `[floor, size]` for the data as it is *now*.
  const limit = Math.min(Math.max(floor, requested), size);

  return {
    limit,
    hasMore: limit < size,
    expanded: limit > floor,
    // Step from the clamped `limit`, not the raw request, so a stale request left over from a
    // larger set doesn't make the first "show more" jump a long way down the new one.
    showMore: () => setRequested(limit + chunk),
    showLess: () => setRequested(floor),
  };
}
