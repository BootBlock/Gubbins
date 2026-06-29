/**
 * Per-location stock ledger row + placement DTO (spec §4, Phase 25). `items.quantity`
 * is the SUM of these placements — a derived projection maintained by the `item_stock`
 * recompute triggers.
 */

export interface ItemStockRow {
  readonly id: string;
  readonly item_id: string;
  readonly location_id: string;
  readonly quantity: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * One placement of an item's stock at a location, with the location's display name —
 * the per-location breakdown shown on the item detail. `items.quantity` is the sum of
 * these (a derived projection maintained by the `item_stock` recompute triggers).
 */
export interface ItemStockPlacement {
  readonly locationId: string;
  readonly locationName: string;
  readonly quantity: number;
}
