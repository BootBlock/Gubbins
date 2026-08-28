/**
 * Tier-3 ephemeral state for the Continuous-Checkout scanner queue (spec §2.1, §6.3).
 *
 * Mirrors the `SearchBuilderContext` pattern: the working queue is highly ephemeral,
 * so it lives in this Context — mounted and unmounted with the scanner overlay —
 * rather than a global store, and the {@link CooldownMap} (the §6.4 2000 ms double-
 * scan guard) is held in a ref scoped to the same lifetime. The reducer
 * ({@link queueReducer}) is pure and unit-tested separately.
 */
import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { CooldownMap } from './cooldown';
import { emptyQueue, hasEntry, queueReducer, type ScannedEntry } from './queue-reducer';

interface ScannerQueueValue {
  readonly entries: readonly ScannedEntry[];
  readonly count: number;
  /**
   * Offer a freshly decoded item id to the queue. Returns true when it was newly
   * accepted (passed the cooldown and was not already queued), false when ignored.
   */
  readonly offer: (itemId: string, name: string | null, now?: number) => boolean;
  readonly remove: (itemId: string) => void;
  readonly clear: () => void;
}

const ScannerQueueContext = createContext<ScannerQueueValue | null>(null);

export function ScannerQueueProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(queueReducer, emptyQueue);
  const cooldown = useRef<CooldownMap>(new CooldownMap());

  const offer = useCallback(
    (itemId: string, name: string | null, now = Date.now()): boolean => {
      if (!cooldown.current.accept(itemId, now)) return false;
      // Bound the map to the ids seen in the last window, however long the overlay stays open.
      cooldown.current.prune(now);
      // The §6.4 belt-and-braces guard catches what the time-based one cannot: two different
      // codes (a label QR and the item's own barcode) naming the same item, and a window that
      // has since elapsed. It is asked here, through the reducer's own predicate, because the
      // reducer would only refuse silently — and a caller told "accepted" plays a confirmation
      // for an entry that never landed (issue #512).
      if (hasEntry(state, itemId)) return false;
      dispatch({ type: 'ADD', entry: { itemId, name, scannedAt: now } });
      return true;
    },
    [state],
  );

  const remove = useCallback((itemId: string) => dispatch({ type: 'REMOVE', itemId }), []);
  const clear = useCallback(() => {
    cooldown.current.clear();
    dispatch({ type: 'CLEAR' });
  }, []);

  const value = useMemo<ScannerQueueValue>(
    () => ({ entries: state.entries, count: state.entries.length, offer, remove, clear }),
    [state.entries, offer, remove, clear],
  );
  return <ScannerQueueContext.Provider value={value}>{children}</ScannerQueueContext.Provider>;
}

export function useScannerQueue(): ScannerQueueValue {
  const value = useContext(ScannerQueueContext);
  if (!value) {
    throw new Error('useScannerQueue must be used within a ScannerQueueProvider.');
  }
  return value;
}
