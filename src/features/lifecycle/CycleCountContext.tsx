/**
 * Tier-3 ephemeral state for a Cycle Counting / Reconciliation session (spec §4.4,
 * §2.1). A blind count of a location is highly transient workflow state, so — like
 * {@link ScannerQueueProvider} — it lives in this Context, mounted and unmounted
 * with the cycle-count dialog, never in a global store or the database. Only the
 * authorised Reconciliation Adjustments are persisted (by `useReconcile`); the
 * variance arithmetic itself lives in the pure, unit-tested `cycle-count` module.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { BatchIdentity } from '@/features/inventory/batches';
import type { SerialisedPresence } from './cycle-count';

/**
 * One line in the count: the expected (database) quantity plus the blind input. Counts are
 * keyed by `key` — a unique `${itemId}|${batchKey}` since Phase 28, so a single DISCRETE item
 * holding several lots at the location is audited one lot at a time, each variance absorbed at
 * its own `stock_batches` row. `batch` is the lot identity passed to the per-batch reconcile.
 */
export interface CycleCountSessionLine {
  readonly key: string;
  readonly itemId: string;
  readonly name: string;
  readonly expected: number;
  readonly batch: BatchIdentity;
}

/** One SERIALISED instance to audit for presence (§4.4 serialised audit). */
export interface SerialisedSessionLine {
  readonly itemId: string;
  readonly name: string;
  readonly serialNo: number | null;
}

interface CycleCountValue {
  /** The location being counted, or null when no session is active. */
  readonly location: { id: string; name: string } | null;
  readonly lines: readonly CycleCountSessionLine[];
  /** Raw counted-quantity input per item (blind — never pre-filled with expected). */
  readonly counts: Readonly<Record<string, string>>;
  /** The SERIALISED instances expected in the location, audited by presence. */
  readonly serialised: readonly SerialisedSessionLine[];
  /** Per-instance present/missing flag (defaults to PRESENT until flagged). */
  readonly presence: Readonly<Record<string, SerialisedPresence>>;
  readonly begin: (
    location: { id: string; name: string },
    lines: readonly CycleCountSessionLine[],
    serialised?: readonly SerialisedSessionLine[],
  ) => void;
  readonly setCount: (itemId: string, value: string) => void;
  readonly setPresence: (itemId: string, value: SerialisedPresence) => void;
  readonly reset: () => void;
}

const CycleCountContext = createContext<CycleCountValue | null>(null);

export function CycleCountProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<{ id: string; name: string } | null>(null);
  const [lines, setLines] = useState<readonly CycleCountSessionLine[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [serialised, setSerialised] = useState<readonly SerialisedSessionLine[]>([]);
  const [presence, setPresenceMap] = useState<Record<string, SerialisedPresence>>({});

  const begin = useCallback(
    (
      loc: { id: string; name: string },
      sessionLines: readonly CycleCountSessionLine[],
      serialisedLines: readonly SerialisedSessionLine[] = [],
    ) => {
      setLocation(loc);
      setLines(sessionLines);
      setCounts({}); // blind: no pre-filled expected values (§4.4)
      setSerialised(serialisedLines);
      // Default every instance present; the auditor actively flags any not found.
      setPresenceMap(Object.fromEntries(serialisedLines.map((l) => [l.itemId, 'PRESENT'])));
    },
    [],
  );

  const setCount = useCallback((itemId: string, value: string) => {
    setCounts((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  const setPresence = useCallback((itemId: string, value: SerialisedPresence) => {
    setPresenceMap((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  const reset = useCallback(() => {
    setLocation(null);
    setLines([]);
    setCounts({});
    setSerialised([]);
    setPresenceMap({});
  }, []);

  const value = useMemo<CycleCountValue>(
    () => ({ location, lines, counts, serialised, presence, begin, setCount, setPresence, reset }),
    [location, lines, counts, serialised, presence, begin, setCount, setPresence, reset],
  );
  return <CycleCountContext.Provider value={value}>{children}</CycleCountContext.Provider>;
}

export function useCycleCount(): CycleCountValue {
  const value = useContext(CycleCountContext);
  if (!value) {
    throw new Error('useCycleCount must be used within a CycleCountProvider.');
  }
  return value;
}
