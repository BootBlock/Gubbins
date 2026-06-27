/**
 * Shared domain constants for the Phase 2 inventory model (spec §4, §4.1).
 *
 * Kept dependency-free so the v2 migration, the repositories, the TanStack Query
 * hooks and the UI can all share a single source of truth without import cycles.
 */

/**
 * Fixed, well-known identifier for the system-locked **"Unassigned"** location
 * (spec §4). It is a deliberately *constant* UUIDv4 — never `crypto.randomUUID()` —
 * because Phase 7's relational-integrity resolution (§7.5.2) re-parents orphaned
 * items to "the system's default Unassigned location ID", which only works if
 * every device shares one canonical id. A random per-device id would create
 * duplicate Unassigned rows that collide on synchronisation.
 */
export const UNASSIGNED_LOCATION_ID = '00000000-0000-4000-8000-000000000001';

/** Display name of the seeded system location. */
export const UNASSIGNED_LOCATION_NAME = 'Unassigned';

/**
 * Fixed, well-known identifier for the system-locked **"In Transit"** location
 * (spec §4 "The Liminal Space of Procurement"). When a BOM line is marked as
 * Ordered/received, incoming stock manifests here rather than in active inventory,
 * distinguishing parts that are *missing* from parts that are *arriving soon*.
 *
 * Like {@link UNASSIGNED_LOCATION_ID} it is a deliberately *constant* UUIDv4 (never
 * `crypto.randomUUID()`) so every synced device shares one canonical id, and it is
 * seeded with `is_system = 1` — so the existing `trg_locations_protect_system_*`
 * guards make it immune to modification and deletion without any new triggers.
 */
export const IN_TRANSIT_LOCATION_ID = '00000000-0000-4000-8000-000000000002';

/** Display name of the seeded system "In Transit" location. */
export const IN_TRANSIT_LOCATION_NAME = 'In Transit';

/**
 * Strict RPC pagination ceiling (spec §2.1): repositories must never return
 * unpaginated arrays. Page reads clamp `limit` to this value to keep the worker
 * bridge and the virtualised lists light even with 100,000+ rows.
 */
export const MAX_PAGE_SIZE = 100;

/** Default page size when a caller does not specify one. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Item tracking levels (spec §4 "Tracking Levels", §4.1.1).
 * - `DISCRETE` — integer quantity (e.g. screws).
 * - `SERIALISED` — quantity forced to 1; cloning is a Phase 3 deliverable.
 * - `CONSUMABLE_GAUGE` — continuously degrading material tracked by net value.
 */
export const TRACKING_MODES = ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/**
 * Immutable Activity Log action types (spec §4 "Activity Log", §4.1.3). The set
 * is intentionally small for Phase 2; later phases append (never repurpose) values.
 */
export const HISTORY_ACTIONS = [
  'CREATED',
  'RENAMED',
  'QUANTITY_CHANGE',
  'GAUGE_UPDATE',
  'MOVED',
  'SOFT_DELETED',
  'RESTORED',
  'RE_PARENTED',
  // Phase 4 — projects, reservations, procurement & assembly (§4 Projects & BOMs).
  'RESERVED', // stock committed to a project (Actually Reserved)
  'RESERVATION_CLEARED', // a reservation released back to free stock
  'PROCURED', // incoming stock manifested in the In-Transit location
  'RECEIVED', // In-Transit stock arrived and moved into active inventory
  'CONSUMED', // parts permanently consumed by an assembly (§4 Permanent Consumption)
  'ASSEMBLED', // an item created as the Singular-Object result of an assembly
  // Phase 6 — borrowing & checking out (§4 Borrowing & Checking Out).
  'CHECKED_OUT', // stock lent to a contact (optionally with a due date)
  'CHECKED_IN', // borrowed stock returned by a contact
  // Phase 8 — external data scraping via extension (§4, §9).
  'SCRAPE_APPLIED', // supplier-scraped fields/alias merged onto the item (§4 no-overwrite)
  // Phase 9 — procurement & lifecycle logistics (§4, §4.3, §4.4).
  'RECONCILED', // cycle-count variance authorised as a Reconciliation Adjustment (§4.4)
  'MAINTENANCE_LOGGED', // a maintenance/calibration service performed, resetting its schedule (§4.3)
  'CONDITION_CHANGED', // the item's Condition enum was changed (§4 Condition Tracking)
  'VARIANT_CREATED', // the item was created/attached as a child variant under a parent (§4 Variant/SKU)
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

// --- Perishables, condition & maintenance (spec §4, §4.3, Phase 9) --------------

/**
 * Operational condition of an item (spec §4 "Condition Tracking", §4.3). Provides
 * granularity beyond the binary active/decommissioned flag (`items.is_active`),
 * reflecting the *current* operational state of high-value serialised assets. A
 * NULL condition simply means "untracked". Soft-deletion states (Decommissioned/
 * Broken/Consumed) remain modelled by `is_active = 0`, not by this enum.
 */
export const CONDITIONS = ['MINT', 'GOOD', 'NEEDS_REPAIR', 'OUT_FOR_CALIBRATION'] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * Basis a maintenance schedule fires on (spec §4.3 "alerts based on time elapsed
 * or usage metrics"):
 * - `TIME` — calendar interval in days from the last service (or creation).
 * - `USAGE` — a manually-logged usage counter (e.g. running hours); due once the
 *   accrued usage since the last service reaches `interval_usage`. No automatic
 *   usage telemetry exists, so the counter is advanced by explicit user entry.
 */
export const MAINTENANCE_BASES = ['TIME', 'USAGE'] as const;
export type MaintenanceBasis = (typeof MAINTENANCE_BASES)[number];

/**
 * Default window (days) before an `expiry_date` within which a perishable item is
 * surfaced as "expiring soon" (spec §4 Perishables, §3 "Soon to Expire" widget).
 */
export const EXPIRY_SOON_WINDOW_DAYS = 30;

/** Milliseconds in one day — shared by the pure expiry/maintenance scheduling maths. */
export const MS_PER_DAY = 86_400_000;

/**
 * Data types a category custom field may declare (spec §4 "Categories & Schema
 * Evolution"). All values persist as TEXT in `item_field_values` (a STRICT table);
 * the field type governs validation in the form layer and casting in the mapper.
 * - `SELECT` constrains values to a defined option list (`category_fields.options`).
 */
export const FIELD_TYPES = ['TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'SELECT'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Attachment/datasheet kinds (spec §4 "Attachments & Datasheets"). `URL` is an
 * external link; `LOCAL_POINTER` stores only the literal local file-path string
 * (never the blob), keeping it sync-safe (§4 Strict Sync Isolation). Which kinds a
 * user may add is governed by the `attachmentMode` preference (Option A vs B).
 */
export const ATTACHMENT_KINDS = ['URL', 'LOCAL_POINTER'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

// --- Projects, BOMs & procurement (spec §4 "Projects & BOMs", Phase 4) ----------

/**
 * Lifecycle status of a project. `PLANNING` is the default new state; `COMPLETED`
 * is set when an assembly outcome is finalised (§4 Composite Items & Assemblies).
 */
export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * BOM costing mode (spec §4 "BOM Costing"). The toggle changes how a project's
 * total cost is calculated:
 * - `CURRENT_REPLACEMENT` (default) — live `items.unit_cost` × required quantity.
 * - `POINT_IN_TIME` — the `unit_cost_snapshot` captured on the BOM line when added.
 */
export const COSTING_MODES = ['CURRENT_REPLACEMENT', 'POINT_IN_TIME'] as const;
export type CostingMode = (typeof COSTING_MODES)[number];

/**
 * Reservation state of a BOM line (spec §4): parts may be `TENTATIVE`ly reserved
 * (a soft intention that does not commit stock) or `ACTUAL`ly reserved (stock
 * committed, logged to the Activity Ledger). `NONE` is unreserved.
 */
export const RESERVATION_STATUSES = ['NONE', 'TENTATIVE', 'ACTUAL'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Procurement state of a BOM line (spec §4 "The Liminal Space of Procurement").
 * `ORDERED`/`IN_TRANSIT` describe parts arriving soon (manifesting in the
 * system-locked In-Transit location); `RECEIVED` parts have arrived.
 */
export const PROCUREMENT_STATUSES = ['NONE', 'ORDERED', 'IN_TRANSIT', 'RECEIVED'] as const;
export type ProcurementStatus = (typeof PROCUREMENT_STATUSES)[number];

/**
 * The three terminal assembly outcomes when a project's parts are assembled
 * (spec §4 "Composite Items & Assemblies"):
 * - `CONTAINER` — the project becomes a Location holding the individual parts.
 * - `SINGULAR_OBJECT` — the parts merge into one new physical inventory Item.
 * - `PERMANENT_CONSUMPTION` — the parts are soft-deleted (consumed) and removed
 *   from active tracking.
 */
export const ASSEMBLY_OUTCOMES = ['CONTAINER', 'SINGULAR_OBJECT', 'PERMANENT_CONSUMPTION'] as const;
export type AssemblyOutcome = (typeof ASSEMBLY_OUTCOMES)[number];

// --- Capabilities & search (spec §4 Weighted Capabilities, §5.1, Phase 5) -------

/**
 * The columns of `items` indexed by the FTS5 virtual table `items_fts` (spec §5
 * FTS5 text matching, §2.2.1a). The order is fixed and shared by the migration
 * (which defines the vtable + sync triggers) and the search layer (which builds
 * column-scoped `MATCH` queries). Changing this list requires a new migration.
 */
export const FTS_ITEM_COLUMNS = ['name', 'description', 'mpn', 'manufacturer'] as const;
export type FtsItemColumn = (typeof FTS_ITEM_COLUMNS)[number];

/**
 * Default relevance weight for a capability (spec §4 "Weighted Capabilities"). A
 * capability carries a `weight` (default 1.0) expressing how salient that spec is
 * for the item, letting search results be ranked by aggregate matched weight
 * rather than treated as flat boolean tags.
 */
export const DEFAULT_CAPABILITY_WEIGHT = 1.0;

// --- Borrowing, checkout & QR (spec §4 Borrowing & Checking Out, §5/§6, Phase 6) -

/**
 * The query parameter a Gubbins item QR code deep-links with (spec §5 printable
 * QR, Phase 6). The encoded payload is the app URL `…/Gubbins/#/inventory?item=<uuid>`
 * — openable by any phone camera, and parsed back to the item id by the in-app
 * scanner. The constant is shared by the QR generator and the scan-payload parser
 * so the contract has a single source of truth.
 */
export const ITEM_QR_PARAM = 'item';

/**
 * A checkout's lifecycle, derived (not a stored enum): a row with `returned_at`
 * NULL is `OPEN` (the item is still out), otherwise `RETURNED`. Exposed as a union
 * for the UI; the database stores only the nullable `returned_at` timestamp so the
 * §7.1 LWW model stays a simple last-write-wins on one column.
 */
export const CHECKOUT_STATUSES = ['OPEN', 'RETURNED'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
