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
  /** Free-text owner's notes — remarks, provenance, quirks; FTS-indexed (§4). */
  readonly notes: string | null;
  readonly location_id: string;
  readonly category_id: string | null;
  readonly tracking_mode: TrackingMode;
  readonly quantity: number;
  readonly unit_of_measure: string | null;
  readonly gross_capacity: number | null;
  readonly tare_weight: number | null;
  readonly current_net_value: number | null;
  readonly attrition_percent: number | null;
  readonly operational_metadata: string | null;
  readonly serial_no: number | null;
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress, v4). */
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Retail barcode (GTIN — EAN/UPC), stored verbatim as printed; null if none. */
  readonly barcode: string | null;
  /**
   * Intrinsic serial number — the maker's unique per-unit identifier printed on the article
   * (issue #90); null if none. Distinct from `serial_no`, which is only a SERIALISED-clone
   * instance index. Stored verbatim and FTS-indexed for search.
   */
  readonly serial_number: string | null;
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
  /**
   * "Unlimited supply" flag (Phase 82): 1 = an effectively infinite source (tap water,
   * mains air). DISCRETE-only (a DB CHECK enforces it); the stored `quantity` is ignored
   * for display and consumption never depletes it.
   */
  readonly is_unlimited: number;
  /** "Favourite" pin (issue #23): 1 = the item sorts ahead of all others in the list. */
  readonly is_favourite: number;
  /** Per-item DISCRETE quantity reorder floor; null = use the global default (v21). */
  readonly reorder_point: number | null;
  /** Per-item CONSUMABLE_GAUGE percentage reorder floor; null = use the global default (v21). */
  readonly reorder_gauge_percent: number | null;
  /** Optional suggested top-up quantity when re-ordering; null = use the shortfall (v21). */
  readonly reorder_qty: number | null;
  /** Date the item was acquired (ISO calendar date string, e.g. `2024-03-15`); null = untracked (v24). */
  readonly acquired_at: string | null;
  /** Date the manufacturer/supplier warranty expires (ISO calendar date string); null = untracked (v24). */
  readonly warranty_expires_at: string | null;
  /** Original acquisition cost in the base currency; null = unpriced (v24). */
  readonly purchase_price: number | null;
  /** Useful life in months for straight-line depreciation; null = no depreciation (v24). */
  readonly depreciation_months: number | null;
  /** Intrinsic mass in **grams** (canonical); null = no weight recorded (issue #25). */
  readonly weight: number | null;
  /** Intrinsic width in **millimetres** (canonical); null = not recorded (issue #30). */
  readonly width: number | null;
  /** Intrinsic height in **millimetres** (canonical); null = not recorded (issue #30). */
  readonly height: number | null;
  /** Intrinsic depth in **millimetres** (canonical); null = not recorded (issue #30). */
  readonly depth: number | null;
  /**
   * Manual current / market value **per unit**, in the base currency; null = none set (v4/G9).
   * Set by the newest {@link RevaluationRow} point and wins over the depreciated replacement
   * cost in valuation. Independent of the depreciation curve — it can move up or down.
   */
  readonly current_value: number | null;
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
  /**
   * Proportional waste applied on top of a requested consumption (issue #89), or `null`
   * when this item has no attrition — the default. Persisted, unlike the two derived
   * fields above.
   */
  readonly attritionPercent: number | null;
}

export interface Item {
  readonly id: string;
  readonly name: string;
  /** What the item *is* — factual, display-worthy copy (e.g. a datasheet summary). */
  readonly description: string | null;
  /** The owner's own free-text notes — remarks, provenance, quirks. FTS-indexed. */
  readonly notes: string | null;
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
  /**
   * Retail barcode (GTIN — EAN/UPC/EAN-8/GTIN-14) as printed on the article; null if
   * none. Recognised by the scanner (see `scanner/gtin.ts`) and used for exact
   * lookup-by-barcode and product enrichment. Distinct from `mpn` (the maker's code).
   */
  readonly barcode: string | null;
  /**
   * Intrinsic serial number — the maker's unique per-unit identifier printed on the article
   * (issue #90); null if none. Distinct from {@link serialNo} (the SERIALISED-clone instance
   * index): this is a free-text identity string that applies to any item and is searchable.
   */
  readonly serialNumber: string | null;
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
  /**
   * "Unlimited supply" modifier (Phase 82): `true` = an effectively infinite source (tap
   * water, mains air/electricity, a bulk pile). DISCRETE-only. When set, the on-hand
   * `quantity` is ignored (rendered as ∞), the item is never low / never on the shopping
   * list, and consuming it is a ledger no-op (see the pure `unlimited.ts` seam).
   */
  readonly isUnlimited: boolean;
  /**
   * "Favourite" pin (issue #23): `true` = the user has starred this item, so it sorts ahead
   * of every non-favourite in the inventory list and shows a favourite indicator in each view.
   * Applies to any item regardless of tracking mode; defaults to `false`.
   */
  readonly isFavourite: boolean;
  /**
   * This item's **own** low-stock trigger (spec §4, Phase 59), overriding the global
   * default when set:
   * - `reorderPoint` — a DISCRETE on-hand quantity floor; the item is low at/below it.
   * - `reorderGaugePercent` — a CONSUMABLE_GAUGE percentage-remaining floor.
   * - `reorderQty` — an optional suggested top-up amount for the shopping list.
   *
   * `null` on any of these means "fall back to the global default" — an item with no
   * override behaves exactly as it did before Phase 59 (never a regression). The pure
   * `reorder-policy.ts` seam decides "is low?"/"reorder how many?" from these.
   */
  readonly reorderPoint: number | null;
  readonly reorderGaugePercent: number | null;
  readonly reorderQty: number | null;
  /**
   * Asset lifecycle fields (Phase 66, v24). All four default to `null` for pre-v24
   * items — an item with none of these set behaves exactly as before (no regression).
   *
   * - `acquiredAt`          — ISO date string (`YYYY-MM-DD`) when the item was acquired; null = untracked.
   * - `warrantyExpiresAt`   — ISO date string when the warranty expires; null = untracked.
   * - `purchasePrice`       — original acquisition cost in the base currency; null = unpriced.
   * - `depreciationMonths`  — useful life for straight-line depreciation; null = no depreciation.
   */
  readonly acquiredAt: string | null;
  readonly warrantyExpiresAt: string | null;
  readonly purchasePrice: number | null;
  readonly depreciationMonths: number | null;
  /**
   * Intrinsic mass, stored canonically in **grams** (issue #25); `null` when no weight is
   * recorded. Applicable to any item — it describes the physical article, not a per-instance
   * lot — so it is copied by "Duplicate item". Presented in the user's `weightUnit` preference
   * (grams are converted for display/entry only; the stored value never changes).
   */
  readonly weight: number | null;
  /**
   * Intrinsic bounding-box dimensions, each stored canonically in **millimetres** (issue #30);
   * `null` when not recorded. Like {@link weight} they describe the physical article (not a
   * per-instance lot), so they are copied by "Duplicate item". Presented in the user's
   * `dimensionUnit` preference (mm are converted for display/entry only; the stored value
   * never changes).
   */
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  /**
   * Manual current / market value **per unit**, in the base currency (feature-gap G9);
   * `null` when none is set. Set by the newest recorded revaluation and — when present —
   * wins over the depreciated replacement cost in valuation (the insurance schedule + the
   * valuation reports). Independent of the depreciation curve, so it can move up or down.
   * The append-only history of the points that set it is the `revaluations` log.
   */
  readonly currentValue: number | null;
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
  /**
   * Proportional waste a draw costs on top of the amount asked for (issue #89), 0–100.
   * Omitted or `null` means no attrition, which is the default.
   */
  readonly attritionPercent?: number | null;
  readonly operationalMetadata?: Record<string, unknown> | null;
}

export interface CreateItemInput {
  readonly name: string;
  readonly description?: string | null;
  /** Free-text owner's notes (§4); omit/null for none. */
  readonly notes?: string | null;
  /** Target location; defaults to the Unassigned location when omitted. */
  readonly locationId?: string;
  readonly categoryId?: string | null;
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress). */
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  /** Retail barcode (GTIN — EAN/UPC); stored verbatim as printed. */
  readonly barcode?: string | null;
  /** Intrinsic serial number — the maker's unique per-unit identifier (issue #90). */
  readonly serialNumber?: string | null;
  /** Current replacement value per unit, in the base currency. */
  readonly unitCost?: number | null;
  /** Perishable expiry instant (UNIX-ms); omit/null for non-perishables (§4). */
  readonly expiryDate?: number | null;
  readonly batchNumber?: string | null;
  readonly lotNumber?: string | null;
  /** Operational condition enum (§4 Condition Tracking). */
  readonly condition?: Condition | null;
  /** "Unlimited supply" modifier (Phase 82); DISCRETE-only, defaults to false. */
  readonly isUnlimited?: boolean;
  /** "Favourite" pin (issue #23); defaults to false. */
  readonly isFavourite?: boolean;
  /** Per-item DISCRETE quantity reorder floor; omit/null to use the global default (§4, v21). */
  readonly reorderPoint?: number | null;
  /** Per-item CONSUMABLE_GAUGE percentage reorder floor; omit/null to use the global default (§4, v21). */
  readonly reorderGaugePercent?: number | null;
  /** Optional suggested top-up quantity when re-ordering (§4, v21). */
  readonly reorderQty?: number | null;
  /** Date the item was acquired, as `YYYY-MM-DD`; omit/null for untracked (§4, v24). */
  readonly acquiredAt?: string | null;
  /** Date the manufacturer/supplier warranty expires, as `YYYY-MM-DD`; omit/null for untracked (§4, v24). */
  readonly warrantyExpiresAt?: string | null;
  /** Original acquisition cost in the base currency; omit/null for unpriced (§4, v24). */
  readonly purchasePrice?: number | null;
  /** Useful life in months for straight-line depreciation; omit/null for no depreciation (§4, v24). */
  readonly depreciationMonths?: number | null;
  /** Intrinsic mass in **grams** (canonical); omit/null for no weight (issue #25). */
  readonly weight?: number | null;
  /** Intrinsic width in **millimetres** (canonical); omit/null for none (issue #30). */
  readonly width?: number | null;
  /** Intrinsic height in **millimetres** (canonical); omit/null for none (issue #30). */
  readonly height?: number | null;
  /** Intrinsic depth in **millimetres** (canonical); omit/null for none (issue #30). */
  readonly depth?: number | null;
  /**
   * Manual current / market value per unit; omit/null for none (feature-gap G9). Seeds the
   * live value at creation without a revaluation log entry (a starting point, like
   * `purchasePrice`); later changes are recorded via `recordRevaluation`.
   */
  readonly currentValue?: number | null;
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
  /**
   * Switch the item's tracking mode *in place*. Only the storage-identical pair
   * `DISCRETE` ↔ `UNTRACKED` is permitted (see `isConvertibleTrackingChange`); any other
   * change throws, as it would require a lossy row-split / column migration. A change is
   * logged as `TRACKING_CHANGED`. The on-hand quantity is preserved either way — `UNTRACKED`
   * merely hides it — so the switch is fully reversible.
   */
  readonly trackingMode?: TrackingMode;
  readonly description?: string | null;
  /** Free-text owner's notes; null clears them (§4). */
  readonly notes?: string | null;
  readonly categoryId?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  /** Retail barcode (GTIN — EAN/UPC); null clears it. */
  readonly barcode?: string | null;
  /** Intrinsic serial number (issue #90); null clears it; omit to leave untouched. */
  readonly serialNumber?: string | null;
  readonly unitCost?: number | null;
  readonly expiryDate?: number | null;
  readonly batchNumber?: string | null;
  readonly lotNumber?: string | null;
  /** Operational condition; a change is logged as `CONDITION_CHANGED` (§4). */
  readonly condition?: Condition | null;
  /**
   * "Unlimited supply" modifier (Phase 82); DISCRETE-only. Toggling it is a plain LWW
   * update (no history action) and lossless — it never rewrites `quantity`.
   */
  readonly isUnlimited?: boolean;
  /**
   * "Favourite" pin (issue #23). Toggling it is a plain LWW update (no history action) — a
   * personal curation, not a change to what the item *is*. Omit to leave it untouched.
   */
  readonly isFavourite?: boolean;
  /** Per-item DISCRETE quantity reorder floor; null clears it back to the global default (§4, v21). */
  readonly reorderPoint?: number | null;
  /** Per-item CONSUMABLE_GAUGE percentage reorder floor; null clears it back to the global default (§4, v21). */
  readonly reorderGaugePercent?: number | null;
  /** Optional suggested top-up quantity when re-ordering; null clears it (§4, v21). */
  readonly reorderQty?: number | null;
  /** Date the item was acquired (`YYYY-MM-DD`); null clears it (§4, v24). */
  readonly acquiredAt?: string | null;
  /** Date the warranty expires (`YYYY-MM-DD`); null clears it (§4, v24). */
  readonly warrantyExpiresAt?: string | null;
  /** Original acquisition cost; null clears it (§4, v24). */
  readonly purchasePrice?: number | null;
  /** Useful life in months for straight-line depreciation; null clears it (§4, v24). */
  readonly depreciationMonths?: number | null;
  /** Intrinsic mass in **grams** (canonical); null clears it; omit to leave untouched (issue #25). */
  readonly weight?: number | null;
  /** Intrinsic width in **millimetres** (canonical); null clears it; omit to leave untouched (issue #30). */
  readonly width?: number | null;
  /** Intrinsic height in **millimetres** (canonical); null clears it; omit to leave untouched (issue #30). */
  readonly height?: number | null;
  /** Intrinsic depth in **millimetres** (canonical); null clears it; omit to leave untouched (issue #30). */
  readonly depth?: number | null;
  /**
   * Manual current / market value per unit (feature-gap G9); `null` clears it (reverting
   * valuation to the depreciated replacement cost). A non-null change here does **not**
   * append to the revaluation log — that is `recordRevaluation`'s job; this path exists for
   * clearing and for import/round-trip. Omit to leave it untouched.
   */
  readonly currentValue?: number | null;
  /**
   * The §4.1.1 schema-less operational-parameter map. Pass a record to replace the
   * stored set wholesale, or `null` to clear it; omit to leave it untouched.
   */
  readonly operationalMetadata?: Record<string, unknown> | null;
}

/**
 * Sell (permanently dispose for proceeds) `quantity` units of a DISCRETE item. Records a
 * `SOLD` ledger entry carrying the realised sale price (→ the sales & margin report). Like a
 * checkout, the units draw down a specific placement/lot; unlike a checkout they never come
 * back. SERIALISED assets are retired via soft-delete instead (their quantity is pinned to 1).
 */
export interface SellItemInput {
  readonly itemId: string;
  /** Units sold; defaults to 1. Must be a positive whole number within the source's on-hand. */
  readonly quantity?: number;
  /** Per-unit sale price in the base currency; defaults to 0 (proceeds = quantity × this). */
  readonly unitSalePrice?: number;
  /** Free-text buyer/counterparty, recorded on the ledger entry; optional. */
  readonly counterparty?: string;
  /** Optional ledger note; a default is generated when omitted. */
  readonly note?: string;
  /** Source placement to sell from; defaults to the item's primary location. */
  readonly fromLocationId?: string;
  /** Source lot to sell from ('' = the untracked default batch); omit for the FEFO draw. */
  readonly fromBatchKey?: string;
}

/**
 * Write off (permanently remove without proceeds) `quantity` units of a DISCRETE item — lost,
 * damaged, expired or binned. Records a `WRITTEN_OFF` ledger entry with an optional reason and a
 * cost snapshot (→ the sales report's write-off total). Draws down a placement/lot like a sale.
 */
export interface WriteOffItemInput {
  readonly itemId: string;
  /** Units written off; defaults to 1. Must be a positive whole number within the on-hand. */
  readonly quantity?: number;
  /** Optional short reason (e.g. "Damaged in transit"), recorded on the ledger entry. */
  readonly reason?: string;
  /** Optional ledger note; a default is generated when omitted. */
  readonly note?: string;
  /** Source placement to write off from; defaults to the item's primary location. */
  readonly fromLocationId?: string;
  /** Source lot to write off from ('' = the untracked default batch); omit for the FEFO draw. */
  readonly fromBatchKey?: string;
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
  /**
   * The attrition breakdown behind this delta (issue #89), when the item has an attrition
   * rate and the user asked to consume an amount. Recording what was *asked for* alongside
   * what actually left is the whole point of the feature — without it the Activity Log
   * shows a 110 g draw against a user who typed 100 and reads like a bug.
   *
   * Only consumption carries this. A weigh-in already measures reality, so inferring waste
   * from it would double-count.
   */
  readonly attrition?: {
    /** The amount the user intended to use. */
    readonly requested: number;
    /** The extra amount attributed to waste. */
    readonly waste: number;
  };
}
