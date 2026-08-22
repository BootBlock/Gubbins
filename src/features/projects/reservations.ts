/**
 * Pure reservation-backing maths (spec §4 "Tentative vs Actual", issue #653).
 *
 * A project reservation is a *claim* on stock that already exists — it never adds any.
 * Nothing physically stops two projects claiming the same units, and stock can be sold,
 * lent or written off after a claim is made, so "is this reservation actually backed by
 * stock?" is a question that has to be answered on every read rather than enforced once
 * at write time.
 *
 * This seam answers it. Given an item's on-hand quantity and every open claim against it,
 * it allocates the stock across the claims in a fixed, device-independent order and reports
 * what each claim actually holds. A claim that misses out is *unbacked*: the project holding
 * it is short those units, and the shopping list says so instead of silently dropping the
 * line.
 *
 * The order is the one a user would expect the shelf to be emptied in: a firm (`ACTUAL`)
 * commitment is served before a soft (`TENTATIVE`) hold, and within each, the reservation
 * made first wins. Every key it sorts on (`status`, `createdAt`, `lineId`) is a synced
 * column, so two devices holding the same rows compute the same allocation.
 */

/** The reservation statuses that actually claim stock — `NONE` is not a claim. */
export type ClaimStatus = 'ACTUAL' | 'TENTATIVE';

/** One BOM line's claim on an item's stock. */
export interface ReservationClaim {
  /** The claiming BOM line — the allocation's key, and unique across projects. */
  readonly lineId: string;
  /** The item claimed. Carried on the claim so a flat result set can be bucketed in one pass. */
  readonly itemId: string;
  readonly projectId: string;
  /** The claiming project's display name, for naming the competitor in the UI. */
  readonly projectName: string;
  readonly status: ClaimStatus;
  /** Units claimed. Never negative; a zero-unit claim holds nothing. */
  readonly reservedQty: number;
  /** When the claiming line was created (UNIX-ms) — the tie-break after `status`. */
  readonly createdAt: number;
}

/** What one claim ended up holding once the item's stock was shared out. */
export interface ClaimBacking {
  readonly lineId: string;
  /** Units of real stock this claim holds. */
  readonly backedQty: number;
  /** Units it claims but has no stock behind (`reservedQty − backedQty`). */
  readonly unbackedQty: number;
}

/** An item's stock commitments — what is claimed, what is backed, and what is left. */
export interface ItemAvailability {
  readonly itemId: string;
  /** The item's on-hand quantity (loans are already out of this — checking out decrements it). */
  readonly onHandQty: number;
  /**
   * `true` for an "unlimited supply" item (Phase 82). Its stock is effectively infinite, so
   * every claim against it is backed and it is never over-committed.
   */
  readonly isUnlimited: boolean;
  /** Units held by firm (`ACTUAL`) claims. */
  readonly actualQty: number;
  /** Units held by soft (`TENTATIVE`) claims. */
  readonly tentativeQty: number;
  /** Every claimed unit, firm and soft (`actualQty + tentativeQty`). */
  readonly reservedQty: number;
  /**
   * Stock nothing has claimed: `onHandQty − reservedQty`, never negative. This is the figure
   * the item dialog and the reservation control mean by "available".
   */
  readonly availableQty: number;
  /** Claimed units with no stock behind them, across all claims. Non-zero = over-committed. */
  readonly overCommittedQty: number;
  /** Per-claim allocation, keyed by BOM line id. Absent = the line claims nothing. */
  readonly backingByLine: ReadonlyMap<string, ClaimBacking>;
  /** Every claim considered, in allocation order — who holds this item, and how firmly. */
  readonly claims: readonly ReservationClaim[];
}

/**
 * The order stock is shared out in: firm claims before soft ones, then oldest first, then by
 * line id so the result never depends on the order the rows arrived in.
 */
function compareClaims(a: ReservationClaim, b: ReservationClaim): number {
  if (a.status !== b.status) return a.status === 'ACTUAL' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

/**
 * Share an item's stock out across the claims on it, and report what each one holds.
 *
 * `claims` may arrive in any order and may span any number of projects; only claims against
 * `itemId` should be passed. An unlimited-supply item backs every claim in full — its stock
 * is not a finite pool to run out of — while still reporting what is claimed, so the UI can
 * show the holds without ever calling them a shortage.
 */
export function computeItemAvailability(
  itemId: string,
  onHandQty: number,
  claims: readonly ReservationClaim[] = [],
  isUnlimited = false,
): ItemAvailability {
  const onHand = Math.max(0, Math.floor(onHandQty));
  const ordered = [...claims].sort(compareClaims);

  let actualQty = 0;
  let tentativeQty = 0;
  let remaining = onHand;
  let overCommittedQty = 0;
  const backingByLine = new Map<string, ClaimBacking>();

  for (const claim of ordered) {
    const wanted = Math.max(0, Math.floor(claim.reservedQty));
    if (claim.status === 'ACTUAL') actualQty += wanted;
    else tentativeQty += wanted;

    // An unlimited item never runs out, so every claim on it is backed in full and the
    // running remainder is meaningless — skip the pool rather than draining it.
    const backedQty = isUnlimited ? wanted : Math.min(wanted, remaining);
    if (!isUnlimited) remaining -= backedQty;
    const unbackedQty = wanted - backedQty;
    overCommittedQty += unbackedQty;
    backingByLine.set(claim.lineId, { lineId: claim.lineId, backedQty, unbackedQty });
  }

  const reservedQty = actualQty + tentativeQty;
  return {
    itemId,
    onHandQty: onHand,
    isUnlimited,
    actualQty,
    tentativeQty,
    reservedQty,
    availableQty: isUnlimited ? onHand : Math.max(0, onHand - reservedQty),
    overCommittedQty,
    backingByLine,
    claims: ordered,
  };
}

/** One item's stock, as {@link computeAvailabilityByItem} needs it. */
export interface ItemStockFacts {
  readonly itemId: string;
  readonly onHandQty: number;
  readonly isUnlimited: boolean;
}

/**
 * Group claims by item and compute each item's availability in one pass — the shape both the
 * BOM table (many lines, many items) and the item dialog (one item) read.
 *
 * `stock` names every item to answer for, so an item with no claims still gets an entry
 * rather than the caller having to invent one. A claim against an item absent from `stock` is
 * dropped: with no on-hand figure there is no pool to allocate, and treating it as zero would
 * report a phantom shortage against an item that may no longer exist.
 */
export function computeAvailabilityByItem(
  stock: readonly ItemStockFacts[],
  claims: readonly ReservationClaim[],
): Map<string, ItemAvailability> {
  const claimsByItem = new Map<string, ReservationClaim[]>();
  const known = new Set(stock.map((s) => s.itemId));
  for (const claim of claims) {
    if (!known.has(claim.itemId)) continue;
    const bucket = claimsByItem.get(claim.itemId);
    if (bucket === undefined) claimsByItem.set(claim.itemId, [claim]);
    else bucket.push(claim);
  }

  const out = new Map<string, ItemAvailability>();
  for (const row of stock) {
    out.set(
      row.itemId,
      computeItemAvailability(row.itemId, row.onHandQty, claimsByItem.get(row.itemId) ?? [], row.isUnlimited),
    );
  }
  return out;
}
