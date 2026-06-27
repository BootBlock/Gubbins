/**
 * Domain row + DTO types for the Phase 2 inventory model.
 *
 * `*Row` types mirror the raw SQLite columns exactly (booleans arrive as 0/1
 * integers, `operational_metadata` as a JSON string). The repository layer maps
 * these into the friendlier camelCase domain objects (`Location`, `Item`,
 * `ItemHistoryEntry`) that the rest of the app consumes, computing the derived
 * gauge values that spec §4.1.1 forbids storing in the database.
 */
import type {
  AttachmentKind,
  CostingMode,
  FieldType,
  HistoryAction,
  ProcurementStatus,
  ProjectStatus,
  ReservationStatus,
  TrackingMode,
} from './constants';

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
  readonly serial_no: number | null;
  /** Manufacturer Part Number — a BOM auto-match key (spec §4 BOM Ingress, v4). */
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Current replacement value per unit, in the base currency (v4). */
  readonly unit_cost: number | null;
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
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Present only when `trackingMode === 'CONSUMABLE_GAUGE'`. */
  readonly gauge: GaugeState | null;
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
}

/**
 * The resolved writes of an external-scrape merge (spec §4, §9). Only the fields
 * the merge engine decided to apply are present — the §4 no-overwrite decision
 * happens upstream in the pure merge engine — plus any supplier MPNs to map in as
 * new aliases. Structurally compatible with the scraping feature's `ScrapeWrite`.
 */
export interface ScrapeApplyInput {
  readonly fields: {
    readonly mpn?: string;
    readonly manufacturer?: string;
    readonly description?: string;
    readonly unitCost?: number;
  };
  readonly aliasAdditions: readonly string[];
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

/** A category plus its custom-field count, for the management list. */
export interface CategoryWithFieldCount extends Category {
  readonly fieldCount: number;
}

export interface CreateCategoryInput {
  readonly name: string;
}

export interface UpdateCategoryInput {
  readonly name?: string;
}

// --- Category custom fields (spec §4 "Categories & Schema Evolution") -----------

export interface CategoryFieldRow {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly field_type: FieldType;
  readonly options: string | null;
  readonly is_required: number;
  readonly default_value: string | null;
  readonly position: number;
  readonly updated_at: number;
}

export interface CategoryField {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly fieldType: FieldType;
  /** Choice list for `SELECT` fields; null otherwise. */
  readonly options: string[] | null;
  readonly isRequired: boolean;
  /** Value applied by lenient defaulting when an item has no stored value. */
  readonly defaultValue: string | null;
  readonly position: number;
  readonly updatedAt: number;
}

export interface CreateCategoryFieldInput {
  readonly name: string;
  readonly fieldType: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  readonly position?: number;
}

export interface UpdateCategoryFieldInput {
  readonly name?: string;
  readonly fieldType?: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  readonly position?: number;
}

/**
 * A category field resolved against a specific item's stored value, applying
 * **lenient defaulting** (spec §4): when no value row exists the field's
 * `defaultValue` (or null) is returned silently — no migration of existing rows.
 */
export interface ResolvedItemField extends CategoryField {
  /** The item's stored value, the field default, or null (lenient defaulting). */
  readonly value: string | null;
  /** True when the value came from a stored row rather than the default. */
  readonly hasStoredValue: boolean;
}

// --- Tags (spec §4, §5 freeform tagging) ----------------------------------------

export interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly updated_at: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

/** A tag plus how many items currently carry it, for the dictionary view. */
export interface TagWithCount extends Tag {
  readonly itemCount: number;
}

// --- Item images (spec §4.2) ----------------------------------------------------

export interface ItemImageRow {
  readonly id: string;
  readonly item_id: string;
  readonly thumbnail_blob: Uint8Array | null;
  readonly full_res_opfs_path: string;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ItemImage {
  readonly id: string;
  readonly itemId: string;
  readonly thumbnailBlob: Uint8Array | null;
  /** Relative OPFS path to the high-resolution WebP (§4.2.2). Never Base64. */
  readonly fullResOpfsPath: string;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateImageInput {
  readonly itemId: string;
  readonly thumbnailBlob: Uint8Array | null;
  readonly fullResOpfsPath: string;
  readonly position?: number;
}

// --- Item attachments / datasheets (spec §4) ------------------------------------

export interface ItemAttachmentRow {
  readonly id: string;
  readonly item_id: string;
  readonly kind: AttachmentKind;
  readonly value: string;
  readonly label: string | null;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ItemAttachment {
  readonly id: string;
  readonly itemId: string;
  readonly kind: AttachmentKind;
  /** The external URL, or the literal local file-path pointer (sync-safe). */
  readonly value: string;
  readonly label: string | null;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateAttachmentInput {
  readonly itemId: string;
  readonly kind: AttachmentKind;
  readonly value: string;
  readonly label?: string | null;
  readonly position?: number;
}

// --- Item aliases (spec §4 Universal Alias Mapping; BOM auto-match) --------------

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

// --- Capabilities (spec §4 "Weighted Capabilities", Phase 5) --------------------

export interface CapabilityRow {
  readonly id: string;
  readonly item_id: string;
  readonly key: string;
  readonly value_num: number | null;
  readonly value_text: string | null;
  readonly weight: number;
  readonly updated_at: number;
}

/**
 * A weighted parametric capability of an item (spec §4). Exactly one of
 * `valueNum`/`valueText` is populated: numeric values back the AST's
 * GREATER_THAN/LESS_THAN comparisons; text values back EQUALS/categorical matches.
 * `weight` (default 1.0) expresses how salient this spec is for relevance ranking.
 */
export interface Capability {
  readonly id: string;
  readonly itemId: string;
  readonly key: string;
  readonly valueNum: number | null;
  readonly valueText: string | null;
  readonly weight: number;
  readonly updatedAt: number;
}

export interface SetCapabilityInput {
  readonly key: string;
  /** Raw value; classified into a numeric magnitude or a text value by the repo. */
  readonly value: string;
  /** Relevance weight (≥ 0); defaults to {@link DEFAULT_CAPABILITY_WEIGHT}. */
  readonly weight?: number;
}

// --- Projects (spec §4 "Projects & BOMs", Phase 4) ------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly costing_mode: CostingMode;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly costingMode: CostingMode;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A project plus its denormalised BOM-line count, for the list view. */
export interface ProjectWithCount extends Project {
  readonly lineCount: number;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string | null;
  readonly costingMode?: CostingMode;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly status?: ProjectStatus;
  readonly costingMode?: CostingMode;
}

// --- BOM lines (spec §4) --------------------------------------------------------

export interface ProjectBomLineRow {
  readonly id: string;
  readonly project_id: string;
  readonly item_id: string | null;
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  readonly required_qty: number;
  readonly reserved_qty: number;
  readonly reservation_status: ReservationStatus;
  readonly procurement_status: ProcurementStatus;
  readonly unit_cost_snapshot: number | null;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ProjectBomLine {
  readonly id: string;
  readonly projectId: string;
  /** The matched local item, or null for an unmatched (manual/import) line. */
  readonly itemId: string | null;
  /** Free-text reference designator(s) (e.g. KiCad "R1, R2"). */
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Free-text part description; the display name when there is no matched item. */
  readonly description: string | null;
  readonly requiredQty: number;
  readonly reservedQty: number;
  readonly reservationStatus: ReservationStatus;
  readonly procurementStatus: ProcurementStatus;
  /** Point-in-time unit cost captured when the line was added (§4 BOM Costing). */
  readonly unitCostSnapshot: number | null;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateBomLineInput {
  /** Match to a local item; when set, mpn/manufacturer/cost snapshot default from it. */
  readonly itemId?: string | null;
  readonly designator?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  readonly description?: string | null;
  readonly requiredQty?: number;
  readonly position?: number;
}

export interface UpdateBomLineInput {
  readonly itemId?: string | null;
  readonly designator?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  readonly description?: string | null;
  readonly requiredQty?: number;
  readonly position?: number;
}

// --- Costing & shopping list (spec §4 BOM Costing; automated Shopping List) ------

/** A project's costed totals under the active costing mode. */
export interface ProjectCosting {
  readonly costingMode: CostingMode;
  /** Total cost = Σ requiredQty × unit cost (live or snapshot per the mode). */
  readonly totalCost: number;
  /** Lines whose unit cost is unknown under the active mode (excluded from total). */
  readonly unpricedLineCount: number;
  readonly lineCount: number;
}

/** A single aggregated shortfall row in a project's automated shopping list. */
export interface ShoppingListEntry {
  /** Matched item id when the shortfall maps to a known item, else null. */
  readonly itemId: string | null;
  /** Display label (item name, else description/mpn/designator). */
  readonly label: string;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Quantity still to acquire (required − reserved), summed across merged lines. */
  readonly shortfallQty: number;
  /** Unit cost used for the estimate (live replacement value when matched). */
  readonly unitCost: number | null;
  /** shortfallQty × unitCost, or null when the unit cost is unknown. */
  readonly estimatedCost: number | null;
}

// --- Assembly finalisation (spec §4 Composite Items & Assemblies) ----------------

export interface FinaliseAssemblyInput {
  /** CONTAINER → new location; SINGULAR_OBJECT → new item; PERMANENT_CONSUMPTION. */
  readonly outcome: import('./constants').AssemblyOutcome;
  /** Name for the resulting container location or singular object item. */
  readonly resultName?: string;
  /** Where the SINGULAR_OBJECT item is placed (defaults to Unassigned). */
  readonly resultLocationId?: string;
}

// --- Contacts & checkouts (spec §4 Borrowing & Checking Out, Phase 6) -----------

export interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A contact plus its denormalised count of still-out (open) checkouts. */
export interface ContactWithCount extends Contact {
  readonly openCount: number;
}

export interface CreateContactInput {
  readonly name: string;
  readonly note?: string | null;
}

export interface UpdateContactInput {
  readonly name?: string;
  readonly note?: string | null;
}

export interface CheckoutRow {
  readonly id: string;
  readonly item_id: string;
  readonly contact_id: string;
  readonly quantity: number;
  readonly due_date: number | null;
  readonly checked_out_at: number;
  readonly returned_at: number | null;
  readonly note: string | null;
  readonly updated_at: number;
}

export interface Checkout {
  readonly id: string;
  readonly itemId: string;
  readonly contactId: string;
  /** Units lent out on this checkout (DISCRETE on-hand is decremented while open). */
  readonly quantity: number;
  /** Optional due date (UNIX-ms) for overdue tracking (§4 Due Dates). */
  readonly dueDate: number | null;
  readonly checkedOutAt: number;
  /** NULL while the item is still out; set when returned (drives OPEN/RETURNED). */
  readonly returnedAt: number | null;
  readonly note: string | null;
  readonly updatedAt: number;
}

/** A checkout joined with its item + contact display names, for list/dashboard rows. */
export interface CheckoutWithNames extends Checkout {
  readonly itemName: string;
  readonly contactName: string;
  readonly status: import('./constants').CheckoutStatus;
  /** True when the checkout is open and its due date is in the past. */
  readonly isOverdue: boolean;
}

export interface CheckoutItemInput {
  readonly itemId: string;
  /** Existing contact id, OR a raw name to low-friction auto-create (§4 Ergonomics). */
  readonly contactId?: string;
  readonly contactName?: string;
  readonly quantity?: number;
  readonly dueDate?: number | null;
  readonly note?: string | null;
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
