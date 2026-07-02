/**
 * Batch / lot-aware per-location stock maths (spec §4 perishables & traceability,
 * Phase 28), kept pure.
 *
 * Phase 25 made `item_stock` the SSOT for *where* an item's units sit (one quantity per
 * `(item, location)`); Phase 28 refines a placement so its units can be split across
 * distinct **batches** — each a `(batch number, lot number, expiry)` identity — with the
 * untracked remainder treated as one anonymous "default" batch. The `stock_batches`
 * ledger persists those rows; this module owns the small arithmetic the repository and
 * UI share — a stable batch key, FEFO ordering, and the **first-expiry-first-out**
 * consumption plan a placement decrement follows — mirroring the pure `planTransfer` /
 * `planReceipt` / `cycle-count` seams the repository trusts.
 */

/**
 * The canonical key for the "untracked" batch — units with no recorded batch/lot/expiry.
 * Empty by design: every existing placement keeps exactly one default-batch row, so the
 * Phase-25 ledger backfills 1:1 and a non-perishable item never grows a batch dimension.
 */
export const DEFAULT_BATCH_KEY = '';

/** A batch's identifying attributes (any combination may be absent). */
export interface BatchIdentity {
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  /** Perishable expiry instant (UNIX-ms); null = non-perishable. */
  readonly expiryDate: number | null;
}

/** A batch row of a single placement: its identity plus the quantity it holds. */
export interface BatchLine extends BatchIdentity {
  readonly batchKey: string;
  readonly quantity: number;
}

/** Trim a string attribute to null when blank, so "" and "  " never spawn a phantom batch. */
function normaliseAttr(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalise a batch identity to its canonical form: blank strings become null and a
 * non-finite expiry becomes null, so equivalent identities always compare and key equal.
 */
export function normaliseBatch(identity: BatchIdentity): BatchIdentity {
  const expiry = identity.expiryDate;
  return {
    batchNumber: normaliseAttr(identity.batchNumber),
    lotNumber: normaliseAttr(identity.lotNumber),
    expiryDate: typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : null,
  };
}

/**
 * A deterministic, collision-free key for a batch identity, stable across devices so two
 * devices recording the same lot at the same placement generate the same `stock_batches`
 * row id and merge by LWW (mirroring the `item_stock` `${item}|${location}` convention).
 * An all-empty identity yields {@link DEFAULT_BATCH_KEY}; otherwise a canonical JSON tuple
 * (which never contains an unescaped delimiter the row-id splitter relies on).
 */
export function batchKeyOf(identity: BatchIdentity): string {
  const { batchNumber, lotNumber, expiryDate } = normaliseBatch(identity);
  if (batchNumber === null && lotNumber === null && expiryDate === null) {
    return DEFAULT_BATCH_KEY;
  }
  return JSON.stringify([batchNumber, lotNumber, expiryDate]);
}

/** True for the anonymous untracked-remainder batch. */
export function isDefaultBatch(batchKey: string): boolean {
  return batchKey === DEFAULT_BATCH_KEY;
}

/**
 * The inverse of {@link batchKeyOf}: reconstruct a batch identity from its canonical key.
 * The default key yields the untracked identity (all-null); a tracked key is the JSON tuple
 * `batchKeyOf` produced, so `batchKeyOf(batchIdentityFromKey(k)) === k` for any key the
 * former generated. A malformed/foreign key degrades to the untracked identity rather than
 * throwing — letting a persisted `source_batch_key` (Phase 29) round-trip a lot back to its
 * own row on a checkout return without the loan record carrying the three identity columns.
 */
export function batchIdentityFromKey(batchKey: string): BatchIdentity {
  if (batchKey === DEFAULT_BATCH_KEY) {
    return { batchNumber: null, lotNumber: null, expiryDate: null };
  }
  try {
    const [batchNumber, lotNumber, expiryDate] = JSON.parse(batchKey) as [
      string | null,
      string | null,
      number | null,
    ];
    return normaliseBatch({ batchNumber, lotNumber, expiryDate });
  } catch {
    return { batchNumber: null, lotNumber: null, expiryDate: null };
  }
}

/**
 * FEFO (First-Expiry-First-Out) order: soonest expiry first, an absent expiry (the
 * untracked remainder and non-perishable lots) always last, ties broken by batch key for
 * a stable, device-independent order. Returns a new array; the input is not mutated.
 */
export function sortFefo<T extends { expiryDate: number | null; batchKey: string }>(
  batches: readonly T[],
): T[] {
  return batches.slice().sort((a, b) => {
    const ax = a.expiryDate ?? Number.POSITIVE_INFINITY;
    const bx = b.expiryDate ?? Number.POSITIVE_INFINITY;
    return ax - bx || a.batchKey.localeCompare(b.batchKey);
  });
}

/** One batch's slice of a consumption plan. */
export interface BatchConsumption {
  readonly batchKey: string;
  /** Units to take from this batch (always positive). */
  readonly amount: number;
}

export interface ConsumptionPlan {
  /** Per-batch withdrawals, in FEFO order, omitting any zero-take batch. */
  readonly consumed: readonly BatchConsumption[];
  /** Units that could not be satisfied because the placement ran dry (0 when fully met). */
  readonly shortfall: number;
}

/**
 * Plan the withdrawal of `amount` units from a placement's batches, **first-expiry-first-out**:
 * the soonest-expiring lots are drawn down before later ones, and the untracked remainder
 * (no expiry) is consumed last. The request is floored to a whole, non-negative count. Any
 * unmet remainder is reported as `shortfall` rather than overdrawing a batch, so the caller
 * (and the `CHECK (quantity >= 0)` safety net) can reject an impossible decrement.
 */
export function planBatchConsumption(batches: readonly BatchLine[], amount: number): ConsumptionPlan {
  let remaining = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
  const consumed: BatchConsumption[] = [];
  for (const batch of sortFefo(batches)) {
    if (remaining <= 0) break;
    const available = Math.max(0, batch.quantity);
    const take = Math.min(available, remaining);
    if (take > 0) {
      consumed.push({ batchKey: batch.batchKey, amount: take });
      remaining -= take;
    }
  }
  return { consumed, shortfall: remaining };
}

/**
 * Plan the withdrawal of `amount` units from **one explicitly chosen lot** of a placement
 * (spec §4 perishables, Phase 29) — the user picking the exact batch to move/lend rather than
 * letting {@link planBatchConsumption} draw FEFO. Only the named batch is consumed: the take
 * is capped at that lot's quantity and any unmet remainder is reported as `shortfall` (so the
 * caller rejects an over-draw) — it never silently spills into other lots. An unknown/empty
 * batch yields the whole `amount` as shortfall.
 */
export function planBatchSelection(
  batches: readonly BatchLine[],
  batchKey: string,
  amount: number,
): ConsumptionPlan {
  const want = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
  const batch = batches.find((b) => b.batchKey === batchKey);
  const available = batch ? Math.max(0, batch.quantity) : 0;
  const take = Math.min(available, want);
  return {
    consumed: take > 0 ? [{ batchKey, amount: take }] : [],
    shortfall: want - take,
  };
}

/** Total units held across a placement's batches. */
export function totalBatched(batches: readonly BatchLine[]): number {
  return batches.reduce((sum, b) => sum + Math.max(0, b.quantity), 0);
}

/**
 * The batches actually holding stock, in FEFO order — the breakdown display order, so a
 * user reads the soonest-to-expire lot at the top. Empty (zeroed) batches are dropped.
 */
export function activeBatches(batches: readonly BatchLine[]): BatchLine[] {
  return sortFefo(batches.filter((b) => b.quantity > 0));
}
