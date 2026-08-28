/**
 * The Continuous-Checkout working queue reducer (spec §2.1 Tier 3, §6.3).
 *
 * In Continuous Mode each accepted scan is pushed to an ephemeral "Working Queue"
 * the user later applies as a batch. Per §2.1 this lives in a local reducer/Context
 * attached to the scanner overlay (mirroring the `SearchBuilderContext` pattern),
 * isolated from the rest of the app and unmounted with the overlay. The reducer is
 * pure and unit-tested; de-duplication by item id means the same physical label
 * scanned twice never lists twice (the time-based 2000 ms guard lives in the
 * `CooldownMap`; this is the belt-and-braces set guard).
 */

export interface ScannedEntry {
  readonly itemId: string;
  /** Display name resolved from the item, or null until/if it loads. */
  readonly name: string | null;
  readonly scannedAt: number;
}

export interface QueueState {
  readonly entries: readonly ScannedEntry[];
}

export type QueueAction =
  { type: 'ADD'; entry: ScannedEntry } | { type: 'REMOVE'; itemId: string } | { type: 'CLEAR' };

export const emptyQueue: QueueState = { entries: [] };

/**
 * Whether the queue already lists `itemId` — the §6.4 belt-and-braces guard. Exported because
 * a pure reducer cannot tell its caller that it refused an action, and the scanner has to know:
 * a refused scan is acknowledged rather than confirmed. One predicate, so the answer the caller
 * acts on and the answer the reducer acts on cannot drift apart.
 */
export function hasEntry(state: QueueState, itemId: string): boolean {
  return state.entries.some((e) => e.itemId === itemId);
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'ADD':
      if (hasEntry(state, action.entry.itemId)) return state;
      return { entries: [...state.entries, action.entry] };

    case 'REMOVE': {
      const next = state.entries.filter((e) => e.itemId !== action.itemId);
      return next.length === state.entries.length ? state : { entries: next };
    }

    case 'CLEAR':
      return state.entries.length === 0 ? state : emptyQueue;

    default:
      return state;
  }
}
