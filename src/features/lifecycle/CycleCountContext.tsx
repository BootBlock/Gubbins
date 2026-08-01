/**
 * Tier-3 state for a Cycle Counting / Reconciliation session (spec §4.4, §2.1). A blind count
 * of a location is transient workflow state, so — like {@link ScannerQueueProvider} — the live
 * sheet lives in this Context, mounted and unmounted with the cycle-count dialog, never in a
 * global store or the database. Only the authorised Reconciliation Adjustments are persisted
 * (by `useAuthoriseCount`); the variance arithmetic itself lives in the pure, unit-tested
 * `cycle-count` module.
 *
 * Transient is not the same as *disposable*, though (issue #587). Both dialogs that mount this
 * provider live inside a `Modal`, so closing one — "Pause & close", Cancel, Escape, a backdrop
 * tap, or a phone reclaiming a backgrounded tab — unmounts it, and the quantities the auditor
 * had typed at that shelf could only be recovered by physically counting it again. So the sheet
 * is mirrored to {@link useCountDraftStore} as it is typed and seeded back from there when the
 * location is next opened: still not database state, but no longer lost to a dropped tab. The
 * count stays **blind** either way — a restored sheet hands back the auditor's own numbers and
 * never the expected quantities.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { BatchIdentity } from '@/features/inventory/batches';
import type { SerialisedPresence } from './cycle-count';
import { reconcilePresence, restoreCountSheet } from './count-draft';
import { useCountDraftStore } from './useCountDraftStore';

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

/** What was handed back from a saved sheet when this location opened (null = a fresh count). */
export interface RestoredCount {
  /** Entries restored — typed counts plus missing flags. Always at least 1. */
  readonly entries: number;
  /** When the sheet was saved (epoch ms), or null if the stored stamp was unusable. */
  readonly savedAt: number | null;
}

interface CycleCountValue {
  /** The location being counted, or null when no session is active. */
  readonly location: { id: string; name: string } | null;
  readonly lines: readonly CycleCountSessionLine[];
  /** Raw counted-quantity input per line (blind — never pre-filled with expected). */
  readonly counts: Readonly<Record<string, string>>;
  /** The SERIALISED instances expected in the location, audited by presence. */
  readonly serialised: readonly SerialisedSessionLine[];
  /** Per-instance present/missing flag (defaults to PRESENT until flagged). */
  readonly presence: Readonly<Record<string, SerialisedPresence>>;
  /** Set when this location opened onto work saved earlier, so the UI can say so. */
  readonly restored: RestoredCount | null;
  readonly begin: (
    location: { id: string; name: string },
    lines: readonly CycleCountSessionLine[],
    serialised?: readonly SerialisedSessionLine[],
  ) => void;
  readonly setCount: (lineKey: string, value: string) => void;
  readonly setPresence: (itemId: string, value: SerialisedPresence) => void;
  /**
   * Empty this location's sheet — the live inputs *and* the saved copy behind them. Both the
   * auditor's "Start over" and the moment a count is authorised go through here: once the sheet
   * has been committed to the ledger it must stop being mirrored, or the next refetch would
   * write it straight back as a draft of work that is now the database's own state.
   */
  readonly clearSheet: () => void;
}

const CycleCountContext = createContext<CycleCountValue | null>(null);

export function CycleCountProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<{ id: string; name: string } | null>(null);
  const [lines, setLines] = useState<readonly CycleCountSessionLine[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [serialised, setSerialised] = useState<readonly SerialisedSessionLine[]>([]);
  const [presence, setPresenceMap] = useState<Record<string, SerialisedPresence>>({});
  const [restored, setRestored] = useState<RestoredCount | null>(null);

  // Which location the sheet below currently belongs to. `begin` is re-run whenever the
  // location's stock is refetched, and re-seeding on those would wipe whatever the auditor had
  // typed since — the very bug this provider now guards against — so only a change of location
  // reseeds the sheet.
  const seededLocationRef = useRef<string | null>(null);

  // Whether the auditor has touched the sheet since it was seeded. The mirror below writes only
  // while this is set, so *opening* a location never rewrites its stored sheet. That matters
  // because seeding is not always a faithful echo of what is stored: stock moves while an audit
  // is paused, and the restore prunes a count whose lot has since been consumed — which makes
  // the seeded sheet differ from the stored one, and a blind mirror would write it back stamped
  // now. The age the resume notice reports has to mean "when this was entered", or the "check
  // the shelf before authorising" judgement it exists to support is being made on a fiction.
  const editedSinceSeedRef = useRef(false);

  const begin = useCallback(
    (
      loc: { id: string; name: string },
      sessionLines: readonly CycleCountSessionLine[],
      serialisedLines: readonly SerialisedSessionLine[] = [],
    ) => {
      setLocation(loc);
      setLines(sessionLines);
      setSerialised(serialisedLines);

      if (seededLocationRef.current === loc.id) {
        // Same location, fresh data: keep the auditor's counts and only reconcile the presence
        // map against the instance list, so an instance that has appeared or left is handled
        // without un-flagging one already judged missing.
        setPresenceMap((previous) => reconcilePresence(serialisedLines, previous));
        return;
      }
      seededLocationRef.current = loc.id;
      editedSinceSeedRef.current = false;

      const sheet = restoreCountSheet(
        useCountDraftStore.getState().drafts[loc.id],
        sessionLines,
        serialisedLines,
      );
      setCounts({ ...sheet.counts });
      setPresenceMap({ ...sheet.presence });
      setRestored(
        sheet.restoredEntries > 0 ? { entries: sheet.restoredEntries, savedAt: sheet.savedAt } : null,
      );
    },
    [],
  );

  const setCount = useCallback((lineKey: string, value: string) => {
    editedSinceSeedRef.current = true;
    setCounts((prev) => ({ ...prev, [lineKey]: value }));
  }, []);

  const setPresence = useCallback((itemId: string, value: SerialisedPresence) => {
    editedSinceSeedRef.current = true;
    setPresenceMap((prev) => ({ ...prev, [itemId]: value }));
  }, []);

  const clearSheet = useCallback(() => {
    const locationId = seededLocationRef.current;
    // Cleared here as well as by the mirroring effect below (which an emptied sheet would also
    // reach): both callers are deliberate, so the stored sheet goes then and there rather than
    // depending on a later effect to notice.
    if (locationId) useCountDraftStore.getState().clear(locationId);
    editedSinceSeedRef.current = false;
    setCounts({});
    setPresenceMap(reconcilePresence(serialised, {}));
    setRestored(null);
  }, [serialised]);

  // Mirror the live sheet to the draft store. Done as an effect rather than inside the setters
  // so the write is driven by committed state (React may call an updater more than once), and
  // read imperatively via `getState()` on the way in so the provider never subscribes to the
  // store it writes on every keystroke. The store no-ops when nothing changed.
  useEffect(() => {
    const locationId = location?.id;
    if (!locationId || seededLocationRef.current !== locationId) return;
    if (!editedSinceSeedRef.current) return; // seeding is not the auditor's work — see the ref above
    useCountDraftStore.getState().save(locationId, counts, presence);
  }, [location, counts, presence]);

  const value = useMemo<CycleCountValue>(
    () => ({
      location,
      lines,
      counts,
      serialised,
      presence,
      restored,
      begin,
      setCount,
      setPresence,
      clearSheet,
    }),
    [location, lines, counts, serialised, presence, restored, begin, setCount, setPresence, clearSheet],
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
