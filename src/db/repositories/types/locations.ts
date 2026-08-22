/**
 * Location domain row + DTO types (spec §4).
 */
import type { DeadStockMode } from '../constants';

export interface LocationRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly is_system: number;
  /** Free-text description for the user's reference (nullable, v19). */
  readonly description: string | null;
  /** Semantic colour swatch key (e.g. 'teal'); NULL = standard text colour (v19). */
  readonly color: string | null;
  /** Chosen icon: a canonical Lucide glyph name (PascalCase); NULL = the generic folder. */
  readonly icon: string | null;
  /** Optional maximum item capacity; NULL = unbounded. Powers the fullness gauge. */
  readonly capacity: number | null;
  /** 1 ⇒ the default location pre-selected when adding new items (at most one row). */
  readonly is_default: number;
  /** Epoch-ms the location was soft-archived; NULL = active/visible. */
  readonly archived_at: number | null;
  /** Epoch-ms a stock-take last completed here; NULL = never counted. */
  readonly last_counted_at: number | null;
  /** Dead-stock reporting for items here; 'inherit' defers to the parent (issue #92). */
  readonly dead_stock_mode: DeadStockMode;
  /** Idle-days threshold for items here; NULL defers up the tree, then to the pref. */
  readonly dead_stock_days: number | null;
  /** Internal width, **canonical mm** (issue #457); NULL = not measured. */
  readonly width: number | null;
  /** Internal height, **canonical mm** (issue #457); NULL = not measured. */
  readonly height: number | null;
  /** Internal depth, **canonical mm** (issue #457); NULL = not measured. */
  readonly depth: number | null;
  /**
   * Explicit usable internal volume, **canonical mm³** (issue #457); overrides the W×H×D
   * product for an irregular container. NULL = derive from width × height × depth.
   */
  readonly usable_volume: number | null;
  /**
   * Per-location packing-efficiency fraction `0 < f ≤ 1` (issue #457); NULL = defer to the
   * global `defaultPackingFactor` preference.
   */
  readonly packing_factor: number | null;
  /**
   * Position on a physical picking sweep (issue #461); NULL = unplaced. The picking worksheet
   * visits placed locations in ascending order, NULLs last, so a multi-item pick is one sweep.
   */
  readonly walk_order: number | null;
  readonly updated_at: number;
}

export interface Location {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isSystem: boolean;
  /** Free-text description for the user's reference (v19). */
  readonly description: string | null;
  /** Semantic colour swatch key; null = standard text colour (v19). */
  readonly color: string | null;
  /** Chosen icon: a canonical Lucide glyph name (PascalCase); null = the generic folder. */
  readonly icon: string | null;
  /** Optional maximum item capacity; null = unbounded. */
  readonly capacity: number | null;
  /** True ⇒ the default location pre-selected when adding new items. */
  readonly isDefault: boolean;
  /** Epoch-ms the location was soft-archived; null = active/visible. */
  readonly archivedAt: number | null;
  /** Epoch-ms a stock-take last completed here; null = never counted. */
  readonly lastCountedAt: number | null;
  /**
   * Whether items stored here are reported as dead stock (issue #92). `inherit` — the
   * default — defers to the parent location, so reporting stays opt-in.
   */
  readonly deadStockMode: DeadStockMode;
  /**
   * The idle-days threshold for items here; null defers up the tree, then to the global
   * preference. Independent of {@link deadStockMode}, so a location can set a house
   * threshold without opting its contents in.
   */
  readonly deadStockDays: number | null;
  /**
   * Internal bounding-box dimensions, each stored canonically in **millimetres** (issue #457);
   * `null` when not measured. Mirror an item's {@link Item.width}/`height`/`depth` so a
   * container and its contents are directly comparable. Presented in the user's `dimensionUnit`
   * preference (mm are converted for display/entry only; the stored value never changes).
   */
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  /**
   * Explicit usable internal volume, stored canonically in **cubic millimetres** (issue #457);
   * `null` = derive from `width × height × depth`. Overrides the raw bounding-box product for a
   * container that isn't a perfect box (a bag, a bin with sloped walls). Phase 1 leaves this
   * unset — the entry UI arrives in Phase 2.
   */
  readonly usableVolume: number | null;
  /**
   * Per-location packing-efficiency fraction `0 < f ≤ 1` (issue #457); `null` defers to the
   * global `defaultPackingFactor` preference. Phase 1 leaves this unset.
   */
  readonly packingFactor: number | null;
  /**
   * This location's position on a physical picking sweep (issue #461); `null` = unplaced. A
   * small non-negative ordinal — "by the door" before "far shelving" — that the project picking
   * worksheet sorts by so a user gathers parts in one route rather than doubling back. Unplaced
   * locations sort after every placed one, so leaving it `null` preserves the prior busiest-first
   * order. Deliberately lighter than X/Y/Z coordinates + pathfinding (issue #461 discussion).
   */
  readonly walkOrder: number | null;
  readonly updatedAt: number;
}

/**
 * The per-location aggregate of the stock physically **placed** there, for cube-utilisation
 * (issue #457). Produced by a bounded GROUP BY over `item_stock` joined to `items`, reading the
 * per-location ledger quantity — not `items.quantity` (the grand total spread across placements).
 * `usedVolume` sums only *measured* items (all three dimensions present); the measured/total unit
 * split drives the honest "based on N of M items" coverage caption.
 *
 * Note the grain differs from {@link LocationWithCount.itemCount}: that counts items by their
 * **home** location regardless of quantity, whereas these totals count stock by where it
 * physically sits, on-hand only and excluding unlimited-supply items — so `totalItems` here can
 * differ from `itemCount` when stock is split across locations.
 *
 * This lives in the db layer (the read produces it) and is consumed structurally by the pure
 * `location-fullness` seam — keep the two shapes in sync.
 */
export interface LocationVolumeTotals {
  /** Σ (item bounding-box volume × units-held-here) over measured items only, canonical mm³. */
  readonly usedVolume: number;
  /** Units held here whose item has all three dimensions. */
  readonly measuredUnits: number;
  /** Total on-hand units held here (measured or not). */
  readonly totalUnits: number;
  /** Distinct measured items here. */
  readonly measuredItems: number;
  /** Distinct items present here. */
  readonly totalItems: number;
}

/** A location plus its denormalised live item count and volume totals, for tree/list rendering. */
export interface LocationWithCount extends Location {
  readonly itemCount: number;
  /**
   * Aggregated stock volume held directly here (issue #457) — feeds the cube-utilisation gauge.
   * Present on the app's tree/list reads (`SELECT_WITH_COUNT`); `undefined` on reads that don't
   * compute it (e.g. the bridge's ad-hoc single-location assembly), where callers fall back to a
   * zeroed aggregate. Optional for the same reason {@link Item.thumbnailBlob} is.
   */
  readonly volumeTotals?: LocationVolumeTotals;
}

/** A location node with its children resolved, for the nested tree view. */
export interface LocationTreeNode extends LocationWithCount {
  readonly children: LocationTreeNode[];
}

export interface CreateLocationInput {
  readonly name: string;
  readonly parentId?: string | null;
  readonly description?: string | null;
  readonly color?: string | null;
  /** Canonical Lucide glyph name (PascalCase); omit/null for the generic folder. */
  readonly icon?: string | null;
  readonly capacity?: number | null;
  readonly isDefault?: boolean;
  readonly deadStockMode?: DeadStockMode;
  readonly deadStockDays?: number | null;
  /** Internal dimensions in **canonical mm** (issue #457); omit/null for not-measured. */
  readonly width?: number | null;
  readonly height?: number | null;
  readonly depth?: number | null;
  /** Explicit usable volume in **canonical mm³** (issue #457); omit/null to derive from W×H×D. */
  readonly usableVolume?: number | null;
  /** Packing-efficiency fraction `0 < f ≤ 1` (issue #457); omit/null to use the global default. */
  readonly packingFactor?: number | null;
  /** Position on the physical picking sweep (issue #461); omit/null for unplaced (sorts last). */
  readonly walkOrder?: number | null;
}

export interface UpdateLocationInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly description?: string | null;
  readonly color?: string | null;
  /** Canonical Lucide glyph name (PascalCase); omit/null for the generic folder. */
  readonly icon?: string | null;
  readonly capacity?: number | null;
  readonly isDefault?: boolean;
  /** Epoch-ms to archive, or null to restore. Undefined leaves it unchanged. */
  readonly archivedAt?: number | null;
  readonly deadStockMode?: DeadStockMode;
  readonly deadStockDays?: number | null;
  /**
   * Internal dimensions in **canonical mm** (issue #457); null clears the value, omit leaves it
   * untouched — the same clear-vs-untouched discipline the item editor uses.
   */
  readonly width?: number | null;
  readonly height?: number | null;
  readonly depth?: number | null;
  /** Explicit usable volume in **canonical mm³** (issue #457); null clears, omit leaves untouched. */
  readonly usableVolume?: number | null;
  /** Packing-efficiency fraction `0 < f ≤ 1` (issue #457); null clears, omit leaves untouched. */
  readonly packingFactor?: number | null;
  /** Position on the picking sweep (issue #461); null clears (unplaced), omit leaves untouched. */
  readonly walkOrder?: number | null;
}
