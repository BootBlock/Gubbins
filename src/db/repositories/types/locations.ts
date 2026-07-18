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
}
