/**
 * Item domain row + DTO types, including the derived Consumable-Gauge state
 * (spec §4, §4.1). `*Row` types mirror the raw SQLite columns; the repository maps
 * these into the camelCase {@link Item}, computing the derived gauge values that
 * spec §4.1.1 forbids storing in the database.
 */
import type { Condition, TrackingMode } from '../constants';

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
  readonly serial_no: number | null;
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress, v4). */
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Current replacement value per unit, in the base currency (v4). */
  readonly unit_cost: number | null;
  /** Perishable expiry instant (UNIX-ms); null = non-perishable (§4, v8). */
  readonly expiry_date: number | null;
  readonly batch_number: string | null;
  readonly lot_number: string | null;
  /** Operational condition enum; null = untracked (§4 Condition, v8). */
  readonly condition: Condition | null;
  /** Parent item id when this is a child variant; null otherwise (§4 Variant, v8). */
  readonly parent_id: string | null;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
  /**
   * Primary thumbnail blob, present only on list/detail reads that JOIN
   * `item_images` (spec §4.2.4). The high-resolution path is *never* selected here.
   */
  readonly thumbnail_blob?: Uint8Array | null;
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
}

export interface Item {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly locationId: string;
  readonly categoryId: string | null;
  readonly trackingMode: TrackingMode;
  readonly quantity: number;
  /**
   * Instance number for a SERIALISED clone (1..N), null otherwise. Clones share a
   * name and are distinguished by this (spec §4 "Serialised" auto-clone).
   */
  readonly serialNo: number | null;
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress). */
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Current replacement value per unit, in the base currency; null if unpriced. */
  readonly unitCost: number | null;
  /** Perishable expiry instant (UNIX-ms); null = non-perishable (§4). */
  readonly expiryDate: number | null;
  /** Manufacturer batch number for perishables/traceability; null if untracked (§4). */
  readonly batchNumber: string | null;
  /** Manufacturer lot number for perishables/traceability; null if untracked (§4). */
  readonly lotNumber: string | null;
  /** Operational condition (Mint/Good/Needs Repair/Out for Calibration); null = untracked (§4). */
  readonly condition: Condition | null;
  /** Parent item id when this is a child variant; null for a standalone/parent item (§4). */
  readonly parentId: string | null;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Present only when `trackingMode === 'CONSUMABLE_GAUGE'`. */
  readonly gauge: GaugeState | null;
  /**
   * The §4.1.1 "flexible metadata layer" — a schema-less, per-item JSON object of
   * arbitrary operational parameters (e.g. `{ bed_temp_celsius: 60 }`). Available on
   * any item, not just gauges; `null` when none are set. Edited via the item detail
   * dialog and the pure `operational-metadata.ts` helpers.
   */
  readonly operationalMetadata: Record<string, unknown> | null;
  /**
   * Primary thumbnail bytes when the read JOINed `item_images` (§4.2.4); `null`
   * when the item has no image, `undefined` on reads that didn't request it.
   */
  readonly thumbnailBlob?: Uint8Array | null;
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
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress). */
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  /** Current replacement value per unit, in the base currency. */
  readonly unitCost?: number | null;
  /** Perishable expiry instant (UNIX-ms); omit/null for non-perishables (§4). */
  readonly expiryDate?: number | null;
  readonly batchNumber?: string | null;
  readonly lotNumber?: string | null;
  /** Operational condition enum (§4 Condition Tracking). */
  readonly condition?: Condition | null;
  readonly trackingMode?: TrackingMode;
  /** Initial quantity for DISCRETE items (SERIALISED is forced to 1 per record). */
  readonly quantity?: number;
  /**
   * For SERIALISED items, how many distinct instance records to auto-clone
   * (spec §4). Defaults to 1; ignored (must be 1) for DISCRETE / CONSUMABLE_GAUGE.
   */
  readonly count?: number;
  /** Required when `trackingMode === 'CONSUMABLE_GAUGE'`. */
  readonly gauge?: GaugeInput;
}

export interface UpdateItemInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly categoryId?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  readonly unitCost?: number | null;
  readonly expiryDate?: number | null;
  readonly batchNumber?: string | null;
  readonly lotNumber?: string | null;
  /** Operational condition; a change is logged as `CONDITION_CHANGED` (§4). */
  readonly condition?: Condition | null;
  /**
   * The §4.1.1 schema-less operational-parameter map. Pass a record to replace the
   * stored set wholesale, or `null` to clear it; omit to leave it untouched.
   */
  readonly operationalMetadata?: Record<string, unknown> | null;
}

/**
 * Thresholds for the §3 dashboard "Low Stock Alerts" feed (Phase 45). Both are
 * optional and default to {@link LOW_STOCK_QTY_THRESHOLD} / {@link LOW_STOCK_GAUGE_PERCENT}.
 */
export interface LowStockThresholds {
  /** A DISCRETE item is low when on-hand `quantity` is at/below this. */
  readonly qtyThreshold?: number;
  /** A CONSUMABLE_GAUGE item is low when its percentage remaining is at/below this. */
  readonly gaugePercent?: number;
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
