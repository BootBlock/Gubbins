/**
 * Per-location stock distribution maths (spec §4, Phase 25), kept pure.
 *
 * The repository persists *where* an item's units sit in the `item_stock` ledger; this
 * module owns the small arithmetic the UI and the repository share — clamping a transfer
 * to what is actually available — mirroring the pure `planReceipt` / `cycle-count` seams
 * the repository trusts.
 */

/** One placement of an item's stock at a location, for the breakdown view. */
export interface StockPlacement {
  readonly locationId: string;
  readonly locationName: string;
  readonly quantity: number;
}

export interface TransferPlan {
  /** The whole, clamped quantity that will actually move (0 when nothing can). */
  readonly quantity: number;
  /** True when a positive quantity can move. */
  readonly ok: boolean;
  /** True when the requested amount was reduced to fit the available stock. */
  readonly clamped: boolean;
}

/**
 * Plan a transfer of `requested` units out of a source location holding `available`. The
 * request is floored to a whole, non-negative unit and clamped to the available stock, so
 * a transfer can never overdraw a location or move a fractional unit.
 */
export function planTransfer(available: number, requested: number): TransferPlan {
  const avail = Math.max(0, Math.floor(Number.isFinite(available) ? available : 0));
  const want = Math.max(0, Math.floor(Number.isFinite(requested) ? requested : 0));
  const quantity = Math.min(want, avail);
  return { quantity, ok: quantity > 0, clamped: quantity < want };
}

/** Total on-hand across every placement (the items.quantity projection, computed here for the UI). */
export function totalOnHand(placements: readonly StockPlacement[]): number {
  return placements.reduce((sum, p) => sum + Math.max(0, p.quantity), 0);
}

/** Placements actually holding stock, busiest first then alphabetical — the breakdown order. */
export function activePlacements(placements: readonly StockPlacement[]): StockPlacement[] {
  return placements
    .filter((p) => p.quantity > 0)
    .slice()
    .sort(
      (a, b) =>
        b.quantity - a.quantity || a.locationName.localeCompare(b.locationName, undefined, { sensitivity: 'base' }),
    );
}
