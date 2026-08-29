/**
 * The reusable per-location count → variance → reconcile engine (spec §4.4), lifted out
 * of {@link CycleCountDialog} so BOTH the standalone "count just this location" dialog and
 * the guided audit-day stepper drive the *same* flow rather than forking it. It owns the
 * per-location load (the DISCRETE `stock_batches` lines plus the SERIALISED presence
 * audit), seeds the ephemeral {@link CycleCountProvider} for the location, exposes the
 * derived variance state, and returns an `authorise()` that persists the adjustments and
 * reports back the totals. Both halves of that load say only what the database *expects* to be
 * here, so the sheet also carries whatever the auditor added because they found it here
 * (issue #640) — an expected-zero count line, or a relocation for a serialised unit. All variance arithmetic stays in the pure `cycle-count` module;
 * this hook is only the glue.
 *
 * Must be used inside a {@link CycleCountProvider} (it reads/writes the transient count).
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getItemRepository,
  type ReconciliationAdjustment,
  type SerialisedReconciliation,
  type SerialisedRelocation,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import {
  countCoverage,
  countLineKey,
  missingInstances,
  serialisedAuditNote,
  serialisedFoundNote,
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

/** The totals reported back when a location's count is authorised. */
export interface AuthoriseResult {
  /** Variance lines found — discrete drift, missing instances, and instances found here. */
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
  /** SERIALISED instances the auditor found here that the records place elsewhere (#640). */
  readonly foundSerialised: ReturnType<typeof useCycleCount>['foundSerialised'];
  /** Every item added to the sheet because it was found here — both tracking modes (#640). */
  readonly found: ReturnType<typeof useCycleCount>['found'];
  readonly addFound: ReturnType<typeof useCycleCount>['addFound'];
  readonly removeFound: ReturnType<typeof useCycleCount>['removeFound'];
  /** Set when this location opened onto a sheet saved earlier (issue #587), else null. */
  readonly restored: ReturnType<typeof useCycleCount>['restored'];
  /** Empty the sheet — live inputs and saved copy — and count this location from scratch. */
  readonly clearSheet: ReturnType<typeof useCycleCount>['clearSheet'];
  /** Discrete lines whose entered count disagrees with the database. */
  readonly drift: ReturnType<typeof variances>;
  /** Serialised instances flagged missing. */
  readonly missing: ReturnType<typeof missingInstances>;
  /** Total adjustments awaiting authorisation (drift + missing + found relocations). */
  readonly totalToApply: number;
  /** How much of the discrete sheet has an entered quantity (issue #637). */
  readonly coverage: CountCoverage;
  /** A reconcile mutation is in flight. */
  readonly pending: boolean;
  /** Persist the variances; resolves with the totals for the session roll-up. */
  readonly authorise: () => Promise<AuthoriseResult>;
}

export function useLocationCycleCount(location: { id: string; name: string }): LocationCycleCount {
  const {
    lines,
    counts,
    serialised,
    presence,
    foundSerialised,
    found,
    restored,
    begin,
    setCount,
    setPresence,
    addFound,
    removeFound,
    clearSheet,
  } = useCycleCount();
  const authoriseCount = useAuthoriseCount();

  // Load the items physically in this location (Phase 26 — per-location; Phase 28 — per-batch).
  // DISCRETE stock is read from the `stock_batches` ledger, so a drawer's lots are each
  // counted separately; SERIALISED instances (single-placement, qty 1) feed the presence
  // audit and come back from one filtered query, uncapped, so an audit can never under-count
  // (issue #561 — this used to walk the location's whole item set and filter in JS).
  const { data, isLoading } = useQuery({
    queryKey: inventoryKeys.locationCycleCount(location.id),
    queryFn: async () => {
      const repo = getItemRepository();
      const [discrete, serialisedItems] = await Promise.all([
        repo.listStockBatchesAtLocation(location.id),
        repo.listSerialisedAtLocation(location.id),
      ]);
      return { discrete, serialised: serialisedItems };
    },
  });

  useEffect(() => {
    if (!data) return;
    begin(
      location,
      data.discrete.map((b) => ({
        key: countLineKey(b.itemId, b.batchKey),
        itemId: b.itemId,
        name: batchLineLabel(b.name, b.batchNumber, b.lotNumber),
        expected: b.quantity,
        batch: { batchNumber: b.batchNumber, lotNumber: b.lotNumber, expiryDate: b.expiryDate },
      })),
      data.serialised,
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
  // A found serialised instance is an adjustment awaiting authorisation in its own right — it
  // writes a relocation — whereas a found DISCRETE line only becomes one once a quantity is
  // typed against it, at which point it is already in `drift` like any other line.
  const totalToApply = drift.length + missing.length + foundSerialised.length;
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
  const isEmpty = !isLoading && lines.length === 0 && serialised.length === 0 && foundSerialised.length === 0;

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
    // The other half of the presence audit (issue #640): an instance the auditor found here is
    // not missing anywhere, it is merely recorded in the wrong place, so it is relocated rather
    // than retired. Sent in the same authorisation so the shelf that lost it and the shelf that
    // has it are corrected together or not at all.
    const relocations: SerialisedRelocation[] = foundSerialised.map((f) => ({
      itemId: f.itemId,
      note: serialisedFoundNote(f, location.name),
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
    const {
      discrete,
      serialised: retired,
      relocated,
    } = await authoriseCount.mutateAsync({
      locationId: location.id,
      quantityAdjustments,
      serialisedAdjustments,
      relocations,
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
      adjustmentsMade: discrete.length + retired.length + relocated.length,
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
    foundSerialised,
    found,
    addFound,
    removeFound,
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
