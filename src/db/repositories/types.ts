/**
 * Domain row + DTO types for the Phase 2 inventory model.
 *
 * `*Row` types mirror the raw SQLite columns exactly (booleans arrive as 0/1
 * integers, `operational_metadata` as a JSON string). The repository layer maps
 * these into the friendlier camelCase domain objects (`Location`, `Item`,
 * `ItemHistoryEntry`) that the rest of the app consumes, computing the derived
 * gauge values that spec §4.1.1 forbids storing in the database.
 */
import type { HistoryAction, TrackingMode } from './constants';

// --- Locations (spec §4) --------------------------------------------------------

export interface LocationRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly is_system: number;
  readonly updated_at: number;
}

export interface Location {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isSystem: boolean;
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
}

export interface UpdateLocationInput {
  readonly name?: string;
  readonly parentId?: string | null;
}

// --- Items (spec §4, §4.1) ------------------------------------------------------

export interface ItemRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly location_id: string;
  readonly category_id: string | null;
  readonly tracking_mode: TrackingMode;
  readonly quantity: number;
  readonly unit_of_measure: string | null;
  readonly gross_capacity: number | null;
  readonly tare_weight: number | null;
  readonly current_net_value: number | null;
  readonly operational_metadata: string | null;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * Derived Consumable-Gauge state (spec §4.1.1). `percentageRemaining` and
 * `currentGrossWeight` are **computed here, never persisted**.
 */
export interface GaugeState {
  readonly unitOfMeasure: string;
  readonly grossCapacity: number;
  readonly tareWeight: number;
  readonly currentNetValue: number;
  readonly percentageRemaining: number;
  readonly currentGrossWeight: number;
  readonly operationalMetadata: Record<string, unknown> | null;
}

export interface Item {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly locationId: string;
  readonly categoryId: string | null;
  readonly trackingMode: TrackingMode;
  readonly quantity: number;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Present only when `trackingMode === 'CONSUMABLE_GAUGE'`. */
  readonly gauge: GaugeState | null;
}

/** Consumable-Gauge parameters supplied when creating a gauge-tracked item. */
export interface GaugeInput {
  readonly unitOfMeasure: string;
  readonly grossCapacity: number;
  /** Empty-container weight/volume; defaults to 0 when omitted (spec §4.1.1). */
  readonly tareWeight?: number;
  /** Usable material remaining; defaults to `grossCapacity` (a full item). */
  readonly currentNetValue?: number;
  readonly operationalMetadata?: Record<string, unknown> | null;
}

export interface CreateItemInput {
  readonly name: string;
  readonly description?: string | null;
  /** Target location; defaults to the Unassigned location when omitted. */
  readonly locationId?: string;
  readonly categoryId?: string | null;
  readonly trackingMode?: TrackingMode;
  /** Initial quantity for DISCRETE items (SERIALISED is forced to 1). */
  readonly quantity?: number;
  /** Required when `trackingMode === 'CONSUMABLE_GAUGE'`. */
  readonly gauge?: GaugeInput;
}

export interface UpdateItemInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly categoryId?: string | null;
}

/**
 * A Consumable-Gauge adjustment (spec §4.1.2). Both interaction modes are
 * normalised to a **relative delta** before reaching the repository, so the
 * Activity Log only ever records relative deltas for Phase 7 CRDT reconciliation.
 */
export interface GaugeAdjustment {
  /** Signed change to `current_net_value` (e.g. -45 for 45 g consumed). */
  readonly delta: number;
  /** Human-readable ledger note (e.g. a weigh-in calibration message). */
  readonly note?: string;
}

// --- Activity Log (spec §4, §4.1.3) ---------------------------------------------

export interface ItemHistoryRow {
  readonly id: string;
  readonly item_id: string;
  readonly action: HistoryAction;
  readonly quantity_delta: number | null;
  readonly net_value_delta: number | null;
  readonly note: string | null;
  readonly metadata: string | null;
  readonly created_at: number;
}

export interface ItemHistoryEntry {
  readonly id: string;
  readonly itemId: string;
  readonly action: HistoryAction;
  readonly quantityDelta: number | null;
  readonly netValueDelta: number | null;
  readonly note: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
}

// --- Categories (Phase 2 minimal stub; schemas/custom fields are Phase 3) --------

export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly updated_at: number;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

// --- Pagination (spec §2.1) -----------------------------------------------------

export interface PageParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly rows: readonly T[];
  readonly limit: number;
  readonly offset: number;
  /** True when another page may exist (a full page was returned). */
  readonly hasMore: boolean;
}
