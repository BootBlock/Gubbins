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
  | { type: 'ADD'; entry: ScannedEntry }
  | { type: 'REMOVE'; itemId: string }
  | { type: 'CLEAR' };

export const emptyQueue: QueueState = { entries: [] };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'ADD':
      // Ignore a duplicate item id already in the queue (§6.4 belt-and-braces).
      if (state.entries.some((e) => e.itemId === action.entry.itemId)) return state;
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
