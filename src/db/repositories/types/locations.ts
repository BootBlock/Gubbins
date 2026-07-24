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
  /** Semantic type key (e.g. 'cabinet'); NULL = generic/folder. Drives iconography. */
  readonly kind: string | null;
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
  /** Semantic type key; null = generic/folder. Drives iconography. */
  readonly kind: string | null;
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
  readonly updatedAt: number;
}

/** A location plus its denormalised live item count, for tree/list rendering. */
export interface LocationWithCount extends Location {
  readonly itemCount: number;
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
  readonly kind?: string | null;
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
}

export interface UpdateLocationInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly description?: string | null;
  readonly color?: string | null;
  readonly kind?: string | null;
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
}
