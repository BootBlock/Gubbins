/**
 * Tier-3 ephemeral state for a Cycle Counting / Reconciliation session (spec §4.4,
 * §2.1). A blind count of a location is highly transient workflow state, so — like
 * {@link ScannerQueueProvider} — it lives in this Context, mounted and unmounted
 * with the cycle-count dialog, never in a global store or the database. Only the
 * authorised Reconciliation Adjustments are persisted (by `useReconcile`); the
 * variance arithmetic itself lives in the pure, unit-tested `cycle-count` module.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** One line in the count: the expected (database) quantity plus the blind input. */
export interface CycleCountSessionLine {
  readonly itemId: string;
  readonly name: string;
  readonly expected: number;
}

interface CycleCountValue {
  /** The location being counted, or null when no session is active. */
  readonly location: { id: string; name: string } | null;
  readonly lines: readonly CycleCountSessionLine[];
  /** Raw counted-quantity input per item (blind — never pre-filled with expected). */
  readonly counts: Readonly<Record<string, string>>;
  readonly begin: (
    location: { id: string; name: string },
    lines: readonly CycleCountSessionLine[],
  ) => void;
  readonly setCount: (itemId: string, value: string) => void;
  readonly reset: () => void;
}

const CycleCountContext = createContext<CycleCountValue | null>(null);

export function CycleCountProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<{ id: string; name: string } | null>(null);
  const [lines, setLines] = useState<readonly CycleCountSessionLine[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});

  const begin = useCallback(
    (loc: { id: string; name: string }, sessionLines: readonly CycleCountSessionLine[]) => {
      setLocation(loc);
      setLines(sessionLines);
      setCounts({}); // blind: no pre-filled expected values (§4.4)
    },
    [],
  );

  const setCount = useCallback((itemId: string, value: string) => {
    setCounts((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  const reset = useCallback(() => {
    setLocation(null);
    setLines([]);
    setCounts({});
  }, []);

  const value = useMemo<CycleCountValue>(
    () => ({ location, lines, counts, begin, setCount, reset }),
    [location, lines, counts, begin, setCount, reset],
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
