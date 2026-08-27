/**
 * The reusable per-location count → variance → reconcile engine (spec §4.4), lifted out
 * of {@link CycleCountDialog} so BOTH the standalone "count just this location" dialog and
 * the guided audit-day stepper drive the *same* flow rather than forking it. It owns the
 * per-location load (the DISCRETE `stock_batches` lines plus the SERIALISED presence
 * audit), seeds the ephemeral {@link CycleCountProvider} for the location, exposes the
 * derived variance state, and returns an `authorise()` that persists the adjustments and
 * reports back the totals. All variance arithmetic stays in the pure `cycle-count` module;
 * this hook is only the glue.
 *
 * Must be used inside a {@link CycleCountProvider} (it reads/writes the transient count).
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getItemRepository,
  type Item,
  type ReconciliationAdjustment,
  type SerialisedReconciliation,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import {
  countCoverage,
  missingInstances,
  serialisedAuditNote,
  variances,
  type CountCoverage,
  type CycleCountLine,
} from './cycle-count';
import { useCycleCount } from './CycleCountContext';
import { useAuthoriseCount } from './hooks';

/** A count line's label: the item name, with the lot's batch/lot number appended if tracked. */
function batchLineLabel(name: string, batchNumber: string | null, lotNumber: string | null): string {
  const tag = batchNumber ?? lotNumber;
  return tag ? `${name} · ${batchNumber ? 'Batch' : 'Lot'} ${tag}` : name;
}

/**
 * Page through **every** item at a location and keep the SERIALISED instances. The
 * previous single `list({ limit: 100 })` silently capped an audit at the first 100 items,
 * so a location holding more than 100 serialised units would be under-counted — a
 * correctness hole in an audit. Paging removes the cap: the loop stops only when the
 * repository reports no further pages, so the presence audit always covers the whole
 * location. (The DISCRETE `stock_batches` read is already unbounded.)
 */
async function listSerialisedAtLocation(
  repo: ReturnType<typeof getItemRepository>,
  locationId: string,
): Promise<Item[]> {
  const PAGE = 200;
  const serialised: Item[] = [];
  let offset = 0;
  for (;;) {
    const page = await repo.list({ locationId, limit: PAGE, offset });
    for (const item of page.rows) {
      if (item.trackingMode === 'SERIALISED') serialised.push(item);
    }
    if (!page.hasMore) break;
    // Advance by the page's own reported size so a repository that returns a different
    // limit than requested still pages correctly.
    offset += page.limit ?? PAGE;
  }
  return serialised;
}

/** The totals reported back when a location's count is authorised. */
export interface AuthoriseResult {
  /** Variance lines found — discrete drift plus missing serialised instances. */
  readonly variancesFound: number;
  /** Reconciliation adjustments actually written to the ledger. */
  readonly adjustmentsMade: number;
  /**
   * Every discrete line carried an entered quantity, so the location was stamped as
   * counted. False for a partial sheet: the adjustments were still applied, but the
   * durable last-counted date was deliberately left alone (issue #637).
   */
  readonly coverageComplete: boolean;
}

export interface LocationCycleCount {
  readonly isLoading: boolean;
  /** True once loaded with nothing countable in this location. */
  readonly isEmpty: boolean;
  /** The DISCRETE count lines (from the provider). */
  readonly lines: ReturnType<typeof useCycleCount>['lines'];
  readonly counts: ReturnType<typeof useCycleCount>['counts'];
  readonly setCount: ReturnType<typeof useCycleCount>['setCount'];
  readonly serialised: ReturnType<typeof useCycleCount>['serialised'];
  readonly presence: ReturnType<typeof useCycleCount>['presence'];
  readonly setPresence: ReturnType<typeof useCycleCount>['setPresence'];
  /** Set when this location opened onto a sheet saved earlier (issue #587), else null. */
  readonly restored: ReturnType<typeof useCycleCount>['restored'];
  /** Empty the sheet — live inputs and saved copy — and count this location from scratch. */
  readonly clearSheet: ReturnType<typeof useCycleCount>['clearSheet'];
  /** Discrete lines whose entered count disagrees with the database. */
  readonly drift: ReturnType<typeof variances>;
  /** Serialised instances flagged missing. */
  readonly missing: ReturnType<typeof missingInstances>;
  /** Total adjustments awaiting authorisation (drift + missing). */
  readonly totalToApply: number;
  /** How much of the discrete sheet has an entered quantity (issue #637). */
  readonly coverage: CountCoverage;
  /** A reconcile mutation is in flight. */
  readonly pending: boolean;
  /** Persist the variances; resolves with the totals for the session roll-up. */
  readonly authorise: () => Promise<AuthoriseResult>;
}

export function useLocationCycleCount(location: { id: string; name: string }): LocationCycleCount {
  const { lines, counts, serialised, presence, restored, begin, setCount, setPresence, clearSheet } =
    useCycleCount();
  const authoriseCount = useAuthoriseCount();

  // Load the items physically in this location (Phase 26 — per-location; Phase 28 — per-batch).
  // DISCRETE stock is read from the `stock_batches` ledger, so a drawer's lots are each
  // counted separately; SERIALISED instances (single-placement, qty 1) feed the presence
  // audit and are paged through in full so an audit is never capped (see the helper above).
  const { data, isLoading } = useQuery({
    queryKey: inventoryKeys.locationCycleCount(location.id),
    queryFn: async () => {
      const repo = getItemRepository();
      const [discrete, serialisedItems] = await Promise.all([
        repo.listStockBatchesAtLocation(location.id),
        listSerialisedAtLocation(repo, location.id),
      ]);
      return { discrete, serialised: serialisedItems };
    },
  });

  useEffect(() => {
    if (!data) return;
    begin(
      location,
      data.discrete.map((b) => ({
        key: `${b.itemId}|${b.batchKey}`,
        itemId: b.itemId,
        name: batchLineLabel(b.name, b.batchNumber, b.lotNumber),
        expected: b.quantity,
        batch: { batchNumber: b.batchNumber, lotNumber: b.lotNumber, expiryDate: b.expiryDate },
      })),
      data.serialised.map((i) => ({ itemId: i.id, name: i.name, serialNo: i.serialNo })),
    );
  }, [data, begin, location]);

  // Only lines the user actually entered a number for participate (blind count).
  const countedLines: CycleCountLine[] = useMemo(
    () =>
      lines
        .filter((l) => counts[l.key]?.trim().length)
        .map((l) => ({
          itemId: l.itemId,
          name: l.name,
          expected: l.expected,
          counted: Number(counts[l.key]),
        })),
    [lines, counts],
  );
  const drift = useMemo(() => variances(countedLines), [countedLines]);
  const missing = useMemo(() => missingInstances(serialised, presence), [serialised, presence]);
  const totalToApply = drift.length + missing.length;
  // Derived from the same line set the count inputs render, so what the footer reports and
  // what the sheet shows can never drift apart.
  const coverage = useMemo(
    () =>
      countCoverage(
        lines.map((l) => l.key),
        counts,
      ),
    [lines, counts],
  );
  const pending = authoriseCount.isPending;
  const isEmpty = !isLoading && lines.length === 0 && serialised.length === 0;

  const authorise = async (): Promise<AuthoriseResult> => {
    // One adjustment per *drifted batch line* (Phase 28): the variance is absorbed at that
    // lot's `stock_batches` row at this placement, so a drawer's lots reconcile
    // independently. Built from the session lines (which carry the lot identity). Only the
    // counted figure and the placement travel — the ledger note's variance is composed
    // against the quantity read as the count is applied, not the one the sheet loaded with,
    // so a drawer that moved while the sheet was open cannot log two different variances
    // (issue #633).
    const quantityAdjustments: ReconciliationAdjustment[] = lines
      .filter((l) => counts[l.key]?.trim().length && Number(counts[l.key]) !== l.expected)
      .map((l) => ({
        itemId: l.itemId,
        counted: Number(counts[l.key]),
        locationName: location.name,
        locationId: location.id,
        batch: l.batch,
      }));
    const serialisedAdjustments: SerialisedReconciliation[] = missing.map((m) => ({
      itemId: m.itemId,
      note: serialisedAuditNote(m, location.name),
    }));
    // One transaction for the whole authorisation (issue #301): the discrete reconciliation,
    // the serialised presence audit and the location's "counted" stamp commit together, so a
    // failure part-way can no longer leave stock adjusted but presence unreconciled. The stamp
    // is written regardless of whether any variance was found — a clean count is still a
    // completed audit, and that durable timestamp is what lets the audit-day picker and
    // LocationInfoCard show how long it's been since a location was verified.
    // A sheet with lines left blank applies its adjustments but does NOT stamp the location
    // as counted (issue #637). The lines that *were* counted are real evidence and worth
    // writing; the stamp is a claim about the whole location, and making it on a part-counted
    // shelf is what let a location nobody counted read as verified.
    const { discrete, serialised: retired } = await authoriseCount.mutateAsync({
      locationId: location.id,
      quantityAdjustments,
      serialisedAdjustments,
      markCounted: coverage.isComplete,
    });
    // The sheet has been committed, so the saved copy that let a paused count resume (issue
    // #587) has done its job — drop it, or reopening this location would offer to restore a
    // count that is now the database's own state. The *live* inputs go with it, not just the
    // stored copy: authorising invalidates this location's query, and the refetch re-runs the
    // provider's mirror effect — a sheet still holding the committed numbers would be written
    // straight back as a fresh draft. Only *after* the write lands, so a failed authorisation
    // leaves the auditor's work exactly where it was.
    clearSheet();
    return {
      variancesFound: totalToApply,
      adjustmentsMade: discrete.length + retired.length,
      coverageComplete: coverage.isComplete,
    };
  };

  return {
    isLoading,
    isEmpty,
    lines,
    counts,
    setCount,
    serialised,
    presence,
    setPresence,
    restored,
    clearSheet,
    drift,
    missing,
    totalToApply,
    coverage,
    pending,
    authorise,
  };
}
