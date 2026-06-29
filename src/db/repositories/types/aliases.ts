/**
 * Item alias row + DTO types (spec §4 Universal Alias Mapping; BOM auto-match).
 */

export interface ItemAliasRow {
  readonly id: string;
  readonly item_id: string;
  readonly alias: string;
  readonly updated_at: number;
}

export interface ItemAlias {
  readonly id: string;
  readonly itemId: string;
  /** A supplier/alternative part identifier mapped to this local item. */
  readonly alias: string;
  readonly updatedAt: number;
}
