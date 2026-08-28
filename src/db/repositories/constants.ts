/**
 * Shared domain constants for the Phase 2 inventory model (spec §4, §4.1).
 *
 * Kept dependency-free so the schema baseline, the repositories, the TanStack Query
 * hooks and the UI can all share a single source of truth without import cycles.
 * (`v1-initial.ts` imports the CHECK-list constants from here, so a column's allowed
 * values and the application's cannot drift apart.)
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
 * Maximum number of pages an infinite item list retains in the TanStack Query cache
 * (spec §2.1 — "light memory with 100,000+ items"). Each list row carries a
 * thumbnail BLOB, so without a cap a deep scroll would accumulate every fetched
 * page's blobs in memory. `maxPages` bounds the resident window to
 * `MAX_LIST_PAGES × DEFAULT_PAGE_SIZE` items (the virtualised list indexes in
 * absolute space, so trimmed pages refetch transparently when scrolled back into
 * view). Sized far larger than the on-screen + overscan window so trimming only
 * happens hundreds of items deep, never near the viewport.
 */
export const MAX_LIST_PAGES = 6;

/**
 * Item tracking levels (spec §4 "Tracking Levels", §4.1.1).
 * - `DISCRETE` — integer quantity (e.g. screws).
 * - `SERIALISED` — quantity forced to 1; cloning is a Phase 3 deliverable.
 * - `CONSUMABLE_GAUGE` — continuously degrading material tracked by net value.
 * - `UNTRACKED` — presence-only: catalogued, searchable and locatable, but with no
 *   quantity to count (a reference manual, the bench vice). Quantity stays 0 and is
 *   never shown; excluded from low-stock, reorder, cycle count, checkout and bookings.
 */
export const TRACKING_MODES = ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE', 'UNTRACKED'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/**
 * Inclusive bounds for a serialised auto-clone `count` — how many distinct instance records a
 * single create may produce (issue #677). The floor is 1 (a create must create something); the
 * ceiling is far above any realistic batch of individually-tracked assets, while keeping a
 * slipped keystroke (`10` typed as `10000`) from committing thousands of records that then have
 * to be selected by hand before they can be removed, and keeping an overflowed value (`1e400`,
 * which is `Infinity` once parsed) out of the clone loop, where it would spin until the tab is
 * killed.
 *
 * These live here, beside the tracking modes, rather than in the inventory feature: the
 * repository is the shared entry point that enforces them, and the Add-item form validates
 * against the same numbers so a rejected count is reported on the field rather than thrown.
 */
export const SERIALISED_COUNT_BOUNDS = { min: 1, max: 500 } as const;

/**
 * Whether a value is usable as a serialised clone count — a safe whole number inside
 * {@link SERIALISED_COUNT_BOUNDS}. `Number.isSafeInteger` rejects `NaN`, `Infinity` and
 * fractions in one go.
 */
export function isValidSerialisedCount(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= SERIALISED_COUNT_BOUNDS.min &&
    value <= SERIALISED_COUNT_BOUNDS.max
  );
}

/**
 * The tracking modes whose stock is represented **identically** in storage — a plain
 * `quantity` plus its per-location `item_stock` ledger row (Phase 25) — and so can be
 * swapped for one another *in place* after creation with no data migration and no loss.
 * `UNTRACKED` simply hides that quantity from the UI and excludes the item from low-stock,
 * reorder, cycle count, checkout and bookings; the underlying stock is preserved, so
 * flipping back to `DISCRETE` reveals it again unchanged.
 *
 * The other two modes can't be reached by an in-place edit: `SERIALISED` splits an item
 * into N one-off instance rows (each qty 1 with its own serial number and history), and
 * `CONSUMABLE_GAUGE` replaces the quantity with capacity/tare/net-value columns. Reaching
 * either from a bulk item is a lossy row-split / column migration, so it is create-time
 * only — make a new item instead.
 */
export const CONVERTIBLE_TRACKING_MODES = ['DISCRETE', 'UNTRACKED'] as const;

/**
 * How an item or a location participates in **dead-stock reporting** (issue #92) — the
 * flagging of stock that has not moved for a long time.
 *
 * Reporting is opt-in, so both `items.dead_stock_mode` and `locations.dead_stock_mode`
 * default to `inherit`, and an item whose whole ancestry is `inherit` is not reported.
 * The resolution rules live in the pure `features/reports/dead-stock` seam.
 *
 * - `inherit` — defer to the location above.
 * - `always` — report, whatever the locations above say.
 * - `never` — don't report, whatever the locations above say.
 */
export const DEAD_STOCK_MODES = ['inherit', 'always', 'never'] as const;
export type DeadStockMode = (typeof DEAD_STOCK_MODES)[number];

/**
 * Whether an item may be switched from tracking mode `from` to `to` by an in-place edit
 * (see {@link CONVERTIBLE_TRACKING_MODES}). Both ends must be convertible and differ. The
 * repository enforces this; the edit UI uses it to decide whether the mode is editable.
 */
export function isConvertibleTrackingChange(from: TrackingMode, to: TrackingMode): boolean {
  const convertible = CONVERTIBLE_TRACKING_MODES as readonly TrackingMode[];
  return from !== to && convertible.includes(from) && convertible.includes(to);
}

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
  'LOAN_RENEWED', // an open loan's due date was changed in place — extended, brought forward, or cleared (B3)
  // Phase 8 — external data scraping via extension (§4, §9).
  'SCRAPE_APPLIED', // supplier-scraped fields/alias merged onto the item (§4 no-overwrite)
  // Phase 9 — procurement & lifecycle logistics (§4, §4.3, §4.4).
  'RECONCILED', // cycle-count variance authorised as a Reconciliation Adjustment (§4.4)
  'MAINTENANCE_LOGGED', // a maintenance/calibration service performed, resetting its schedule (§4.3)
  'CONDITION_CHANGED', // the item's Condition enum was changed (§4 Condition Tracking)
  'VARIANT_CREATED', // the item was created/attached as a child variant under a parent (§4 Variant/SKU)
  'TRACKING_CHANGED', // the item's tracking mode was switched in place (Discrete ↔ Untracked)
  // Kits v2 — assemble/disassemble stock operations. ASSEMBLED (above, reused) logs the kit
  // being built up from its components; DISASSEMBLED logs it being broken back down.
  'DISASSEMBLED', // a kit broken down, its components returned to stock (inverse of ASSEMBLED)
  // Outbound disposals & supplier refunds — stock leaving inventory for a commercial reason.
  'SOLD', // stock sold to a buyer (records a sale price → the sales/margin report)
  'WRITTEN_OFF', // stock written off as lost/damaged/expired (no proceeds, optional reason)
  'RETURNED_TO_SUPPLIER', // received stock refunded back to a supplier (inverse of RECEIVED)
  // Feature-gap G9 — a manual current/market revaluation was recorded (append-only value log).
  'REVALUED', // the item's manual current value was (re)set, independent of depreciation
  // Feature-gap G7 — a per-instance test / calibration / service record was logged (QA audit trail).
  'TESTED', // a structured pass/fail + reading record was added against a serialised unit
  // An edit to the item's structured attributes — price, identity, classification, reordering,
  // perishability, provenance, lifecycle dates and measurements (webhooks W10, issue #144).
  // Deliberately **one** generic action rather than one per field: which fields moved, and what
  // each held before and after, rides the entry's note/metadata, so the public event vocabulary
  // stays as it is (`item.changed`) instead of growing a type per column.
  'ATTRIBUTES_CHANGED',
  // The item's own ledger was cleared on purpose (issue #620). The one entry that survives a
  // clear, so the log never simply goes blank: an emptied audit trail that says nothing is
  // indistinguishable from an item nothing ever happened to.
  //
  // It is also the **watermark** the sync engine reads: `item_history` reconciles by
  // union-by-id, so without a marker in the ledger itself a peer would hand the cleared rows
  // straight back on the next merge. Entries older than the newest `HISTORY_CLEARED` for an
  // item are neither imported nor kept — see `reconcileHistory`.
  'HISTORY_CLEARED',
  // A sync merge discarded this device's version of one or more of the item's fields (issue
  // #487). The counterpart to `ATTRIBUTES_CHANGED` for the one path that changes an item without
  // anybody editing it: last-write-wins adopted a peer's newer row, and the values it overwrote
  // would otherwise have vanished with nothing in the ledger saying so. Attributed to the System
  // user, because no person asked for it.
  'MERGE_OVERWRITTEN',
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/**
 * Location activity-record action types (issue #691) — the `location_history` counterpart of
 * {@link HISTORY_ACTIONS}, and deliberately a **separate, much smaller** vocabulary rather than a
 * reuse of it. The two ledgers describe different subjects, and the overlap is only apparent:
 * an item's `RE_PARENTED` means "its location was removed under it", while a location's means
 * "it was moved under a different parent".
 *
 * Kept to the lifecycle changes that reshape the hierarchy, which is what nobody could audit.
 * Geometry, colour, capacity and policy edits deliberately record **nothing** in this first pass —
 * they change how a place is described, not where anything is. Later phases append (never
 * repurpose) values, exactly as {@link HISTORY_ACTIONS} does.
 */
export const LOCATION_HISTORY_ACTIONS = [
  'CREATED', // the location was added to the hierarchy
  'RENAMED', // its name changed
  'RE_PARENTED', // it was moved under a different parent (or out to the root)
  'ARCHIVED', // it was hidden from the tree and the pickers
  'RESTORED', // an archived location was brought back
  'DELETED', // it was removed; its contents were re-homed and its children promoted
] as const;
export type LocationHistoryAction = (typeof LOCATION_HISTORY_ACTIONS)[number];

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
 * - `USAGE` — a usage counter (e.g. running hours); due once the accrued usage
 *   since the last service reaches `interval_usage`. The counter is advanced by
 *   explicit user entry, or — where the schedule opts in via
 *   `accrue_checkout_hours` — derived on read from the `checkouts` ledger, so a
 *   tool's loan hours count towards its next service automatically.
 */
export const MAINTENANCE_BASES = ['TIME', 'USAGE'] as const;
export type MaintenanceBasis = (typeof MAINTENANCE_BASES)[number];

/**
 * Default window (days) before an `expiry_date` within which a perishable item is
 * surfaced as "expiring soon" (spec §4 Perishables, §3 "Soon to Expire" widget).
 */
export const EXPIRY_SOON_WINDOW_DAYS = 30;

/**
 * Default idle window (days) after which unmoved stock is reported as **dead stock**
 * (issue #92, §3 Reports). The user-tunable preference and individual locations both
 * override it; this is only the starting value and the fallback for invalid input.
 */
export const DEAD_STOCK_SINCE_DAYS = 90;

/**
 * Inclusive bounds (days) for a dead-stock idle threshold — the global preference and any
 * per-location override alike. The floor is 1 (a zero-day threshold would flag everything
 * the moment it was added); the ceiling of ten years is generous enough for archival
 * storage while keeping a mistyped value from silently disabling the report.
 *
 * These live here, beside the default, rather than in the settings feature: the repository
 * layer clamps location overrides with them, and a repository must not reach up into a
 * feature module to do it. `features/settings` re-exports them for the UI call sites.
 */
export const DEAD_STOCK_DAYS_BOUNDS = { min: 1, max: 3650 } as const;

/**
 * Clamp a dead-stock idle threshold to {@link DEAD_STOCK_DAYS_BOUNDS}, rounded to a whole
 * number. Non-finite input falls back to {@link DEAD_STOCK_SINCE_DAYS}.
 */
export function clampDeadStockDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEAD_STOCK_SINCE_DAYS;
  return Math.min(DEAD_STOCK_DAYS_BOUNDS.max, Math.max(DEAD_STOCK_DAYS_BOUNDS.min, Math.round(value)));
}

/**
 * Default window (days) before a `warranty_expires_at` date within which an asset's
 * warranty is surfaced as "expiring soon" (spec §3 alert centre, §4 asset facet). The
 * feature-layer `WARRANTY_EXPIRING_SOON_DAYS` re-exports this so the alert centre and the
 * inventory "Warranty" status filter judge warranty-soon-ness against one shared window.
 */
export const WARRANTY_SOON_WINDOW_DAYS = 30;

/**
 * Default "low stock" thresholds for the §3 dashboard "Low Stock Alerts" widget.
 *
 * **Off by default — low-stock alerts are opt-in.** A threshold of `0` means "off":
 * the item is never flagged. We can't guess a sensible "low" level for an arbitrary
 * item (one screw low is fine; one rare connector low is a crisis), so a freshly-added
 * item never nags on the dashboard. A user opts an item in by giving it its own
 * `reorder_point` / `reorder_gauge_percent`, or opts *everything* in at once by raising
 * the global blanket default in Settings above 0.
 *
 * When the effective threshold is positive, a DISCRETE/SERIALISED item is low when its
 * on-hand `quantity` is at or below {@link LOW_STOCK_QTY_THRESHOLD}; a CONSUMABLE_GAUGE
 * item is low when its `percentage_remaining` is at or below {@link LOW_STOCK_GAUGE_PERCENT}
 * (§4 "low-stock alerts based on percentage or remaining weight rather than integer
 * counts" — the §4.1.3 crimson gauge zone). Both are overridable per call.
 */
export const LOW_STOCK_QTY_THRESHOLD = 0;
export const LOW_STOCK_GAUGE_PERCENT = 0;

/**
 * Suggested starting reorder points offered when a user *opts an item in* to low-stock
 * alerts (e.g. the Add-item dialog pre-fills these the moment the "alert me when this runs
 * low" toggle is switched on). Deliberately distinct from the now-off-by-default global
 * {@link LOW_STOCK_QTY_THRESHOLD} / {@link LOW_STOCK_GAUGE_PERCENT}: those govern whether an
 * item is watched *at all* (0 = off), while these are just a friendly non-zero default to
 * save the user typing once they've decided they do want an alert. The old blanket defaults
 * (5 units / 15 %) make sensible starting points.
 */
export const LOW_STOCK_QTY_SUGGESTED = 5;
export const LOW_STOCK_GAUGE_SUGGESTED = 15;

/**
 * Default warning threshold for the §4 project budget feature: a project's budget
 * indicator turns to a warning tone once spend reaches this percentage of the budget,
 * and an over-budget state once it exceeds 100%. Surfaced as the user-tunable Tier-2
 * `budgetWarnPercent` preference (clamped to {@link BUDGET_WARN_BOUNDS}), mirroring the
 * low-stock-threshold seam. A "fixed constant → Tier-2 preference" lift (the Phase-46
 * pattern) so a user who runs tighter or looser on budgets can move the line.
 */
export const BUDGET_WARN_PERCENT = 80;

/** Milliseconds in one day — shared by the pure expiry/maintenance scheduling maths. */
export const MS_PER_DAY = 86_400_000;

/** Milliseconds in one hour — the unit of checkout-hours maintenance telemetry (§4.3). */
export const MS_PER_HOUR = 3_600_000;

/**
 * Data types a category custom field may declare (spec §4 "Categories & Schema
 * Evolution"). All values persist as TEXT in `item_field_values` (a STRICT table);
 * the field type governs validation in the form layer and casting in the mapper.
 * - `SELECT` constrains values to a defined option list (`category_fields.options`).
 * - `BOOLEAN` and `ON_OFF` are functionally identical (both store `'true'`/`'false'`)
 *   — `ON_OFF` exists purely as an alternate wording for a toggle-style field.
 * - `FILE` stores a **link** to a file that lives outside the app — a local path, a
 *   UNC share (`\\server\share\…`), or a `file://` / `http(s)` URI. Only the string
 *   travels (it syncs and backs up like any other value); the file itself is never
 *   copied, so the pointer stays valid only on a device that can reach that path.
 * - `IMAGE` stores a small cover image **in the database**, as a bounded WebP encoded
 *   into a `data:` URL (compressed on the way in — see `encodeFieldImage`). Because it
 *   lives in `item_field_values.value` it syncs and backs up with everything else; the
 *   size cap keeps the synced database from ballooning.
 * - `COLOUR` stores a colour as a canonical lowercase `#rrggbb` (or `#rrggbbaa` when it
 *   carries alpha). The user may type or paste hex, `rgb()`, `hsl()`, HSB/HSV or a CSS
 *   colour name — `src/lib/colour.ts` parses all of them down to that one spelling, so two
 *   devices that entered the same colour by different routes store the same string. The
 *   canonical form is what makes grouping, equality and search work without a colour parser
 *   in the SQL; the other notations are a *display* choice, offered back on demand.
 */
export const FIELD_TYPES = [
  'TEXT',
  'LONG_TEXT',
  'URL',
  'NUMBER',
  'RATING',
  'BOOLEAN',
  'ON_OFF',
  'DATE',
  'SELECT',
  'COLOUR',
  'FILE',
  'IMAGE',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Bounds on `field_defs.due_lead_days` — a `DATE` custom field's **due-date opt-in** (W1a).
 *
 * A custom `DATE` field is inert by default, and deliberately so: "Date acquired" is a fact,
 * not a deadline. `due_lead_days` is the whole opt-in — `NULL` means "just a date", and any
 * value means "this is a deadline; raise it this many calendar days before it falls due". One
 * nullable column rather than a boolean *plus* a lead time, because two columns can disagree
 * ("opted in, no notice") and that disagreement would have no meaning.
 *
 * The lead time is per definition rather than one shared preference because deadlines are not
 * alike: a subscription renewal wants a fortnight, a calibration certificate a quarter, a
 * "return by" a day or two. A single shared window would make the feature miss most of what it
 * exists to surface. `0` is legitimate — "tell me on the day".
 *
 * Interpolated into the `field_defs` CHECK, so the schema and the app clamp to the same range
 * (see `clampFieldDueLeadDays` in `@/features/lifecycle/field-due`).
 */
export const FIELD_DUE_LEAD_DAYS_MIN = 0;
/** A year's notice — beyond this a "reminder" stops being one. See {@link FIELD_DUE_LEAD_DAYS_MIN}. */
export const FIELD_DUE_LEAD_DAYS_MAX = 365;
/** The lead time offered when a field is first opted in — two weeks' notice. */
export const FIELD_DUE_LEAD_DAYS_DEFAULT = 14;

/**
 * Bounds on `field_defs.unit` — a `NUMBER` custom field's **unit of measure** (W1b).
 *
 * A unit is a *symbol*, not a sentence: `mm`, `V`, `kg`, `kWh/100km`, `µg/m³`. The cap is
 * generous enough for a compound SI unit and tight enough that the value it sits beside stays
 * the thing being read — a card renders `5 V`, and a unit long enough to wrap would turn that
 * into prose. `NULL` means "no unit", and so does a blank: the write seam folds one to the
 * other, the same way a value is never stored as `''` (see `validateFieldValue`).
 *
 * Interpolated into the `field_defs` CHECK, so the schema and the app clamp to the same range.
 */
export const FIELD_UNIT_MAX_LENGTH = 16;

/**
 * The outer limit on `field_defs.min_value` / `max_value` — a `NUMBER` custom field's
 * **range** (W1c), either side of zero.
 *
 * `Number.MAX_SAFE_INTEGER` rather than a round figure, because that is precisely where a
 * JavaScript number stops being exact: past it, `n` and `n + 1` can be the same double, so a
 * bound stored there would not reliably mean what it says, and the comparison the validator
 * makes against it would be arbitrary. It also keeps `±Infinity` out of a `REAL` column that
 * would otherwise accept it (SQLite stores `9e999` happily; it turns `NaN` into `NULL`).
 *
 * Each bound is **independently** nullable and `NULL` means *unbounded on that side*, which is
 * the deliberate difference from {@link FIELD_DUE_LEAD_DAYS_MIN}'s single-column opt-in: a
 * one-sided range ("never negative", "at most 100") is a constraint users genuinely want, so a
 * half-set pair is legitimate rather than a half-finished one. An **inverted** pair is not —
 * `min > max` admits no value at all, so the CHECK forbids it and the write seam refuses it
 * first, in the app's voice. `min = max` is allowed: it means "exactly this".
 *
 * Interpolated into the `field_defs` CHECK, so the schema and the app clamp to the same range.
 */
export const FIELD_NUMBER_BOUND_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Bounds on `field_defs.precision` — a `NUMBER` custom field's **decimal places** (W1e).
 *
 * Unlike {@link FIELD_NUMBER_BOUND_LIMIT}, this is not a third bound of the same kind. A range
 * only ever *refuses* a value; a precision also decides how a stored one is written — `5.5` on a
 * 2-decimal field reads `5.50`. `NULL` means "as entered", which is what every existing field
 * has and what keeps them rendering exactly as before.
 *
 * `0` is the case the setting most exists for: "whole numbers only" is a rule a range cannot
 * express — no pair of bounds excludes `2.5` while admitting `2` and `3`.
 *
 * The cap is 6 because that is roughly where the setting stops meaning anything. Six places
 * covers any realistic measurement (a micrometre written in metres is `0.000001`), and it stays
 * far enough inside a double's ~15 significant digits that the round-trip test the validator
 * makes — does writing the value at this precision lose anything? — still answers truthfully for
 * values of everyday size. Note it says nothing about the *range*: a field bounded near
 * {@link FIELD_NUMBER_BOUND_LIMIT} has already spent those digits on its integer part, and no
 * decimal place is exact up there whatever this is set to.
 *
 * Interpolated into the `field_defs` CHECK, so the schema and the app clamp to the same range.
 */
export const FIELD_PRECISION_MIN = 0;
/** Six decimal places — see {@link FIELD_PRECISION_MIN} for why the cap sits there. */
export const FIELD_PRECISION_MAX = 6;

/**
 * Attachment/datasheet kinds (spec §4 "Attachments & Datasheets"). `URL` is an
 * external link; `LOCAL_POINTER` stores only the literal local file-path string
 * (never the blob), keeping it sync-safe (§4 Strict Sync Isolation). Which kinds a
 * user may add is governed by the `attachmentMode` preference (Option A vs B).
 */
export const ATTACHMENT_KINDS = ['URL', 'LOCAL_POINTER'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

// --- Location photos & regions (issue #81) --------------------------------------

/**
 * The shapes a location-photo region can take. A region marks *where* something sits
 * within a photo of a location ("Top shelf", "Drawer 2"); items reference it many-to-many,
 * so a region is a place that exists independently of what is in it.
 *
 * Geometry is stored as JSON in **normalised image space** (0–1 per axis) so re-encoding a
 * photo at a different size never moves its regions. The pure `features/inventory/regions`
 * seam owns the coordinate maths — including the circle aspect correction, since a radius
 * normalised per-axis would render as an ellipse on a non-square photo.
 */
export const REGION_SHAPES = ['rect', 'circle', 'polygon'] as const;
export type RegionShape = (typeof REGION_SHAPES)[number];

// --- Projects, BOMs & procurement (spec §4 "Projects & BOMs", Phase 4) ----------

/**
 * Lifecycle status of a project. `PLANNING` is the default new state; `COMPLETED`
 * is set when an assembly outcome is finalised (§4 Composite Items & Assemblies).
 */
export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * The statuses a project has *finished* in — the build shipped, or it was shelved. Named
 * because "is this project still live?" is asked in more than one place (the Dashboard's
 * Projects tile counts the ones that are not), and a hand-repeated
 * `status !== 'COMPLETED' && status !== 'ARCHIVED'` is exactly the sort of pair that drifts
 * when a fifth status is added.
 */
export const TERMINAL_PROJECT_STATUSES = ['COMPLETED', 'ARCHIVED'] as const;

/**
 * The complement of {@link TERMINAL_PROJECT_STATUSES} — a project still being worked on.
 * **Derived** from {@link PROJECT_STATUSES} rather than listed again, so a new status joins
 * the active set unless it is explicitly declared terminal.
 */
export const ACTIVE_PROJECT_STATUSES: readonly ProjectStatus[] = PROJECT_STATUSES.filter(
  (status): status is ProjectStatus => !(TERMINAL_PROJECT_STATUSES as readonly string[]).includes(status),
);

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
export const FTS_ITEM_COLUMNS = [
  'name',
  'description',
  'notes',
  'mpn',
  'manufacturer',
  'barcode',
  'serial_number',
] as const;
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
 * The query parameter a Gubbins **location** label deep-links with (Phase 73 "Label
 * customisation"). A printed location label encodes the app URL
 * `…/Gubbins/#/inventory?location=<uuid>` — a phone camera opens the app filtered to
 * that location, and the in-app scanner selects it. Shared by the label generator and
 * the scan-payload parser so the contract has a single source of truth, and kept
 * distinct from {@link ITEM_QR_PARAM} so the two code kinds are never confused.
 */
export const LOCATION_QR_PARAM = 'location';

/**
 * A checkout's lifecycle, derived (not a stored enum): a row with `returned_at`
 * NULL is `OPEN` (the item is still out), otherwise `RETURNED`. Exposed as a union
 * for the UI; the database stores only the nullable `returned_at` timestamp so the
 * §7.1 LWW model stays a simple last-write-wins on one column.
 */
export const CHECKOUT_STATUSES = ['OPEN', 'RETURNED'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/**
 * What a loan is checked out **to** (B4). A tool is not always lent to a *person*: it may be
 * "out on the Henderson job" (a project) or "in the van" (a location). The borrower is a
 * tagged union of exactly one of these three targets — enforced in storage by the `checkouts`
 * XOR CHECK across the nullable `contact_id` / `project_id` / `location_id` columns, and in the
 * type layer by {@link CheckoutBorrower}. `contact` keeps the low-friction resolve-or-create-
 * by-name convenience; `project` / `location` are always picked from existing rows.
 */
export const BORROWER_TYPES = ['contact', 'project', 'location'] as const;
export type BorrowerType = (typeof BORROWER_TYPES)[number];

/**
 * What kind of principal a `users` row is (issue #79, plan §2.2).
 *
 * - `system` — the actor the app itself writes as: maintenance, pruning, imports run by a
 *   schedule, and sync reconciliation repairing a dangling attribution. Never signs in.
 * - `admin` — full access to everything, always. This is the user single-user mode
 *   transparently acts as, so a Gubbins with the users module switched off attributes every
 *   action to it.
 * - `normal` — an ordinary account whose permissions come from its {@link Role}.
 *
 * The first two are seeded by the baseline with the fixed ids below and are protected from
 * deletion and modification by `trg_users_protect_builtin_*`.
 */
export const USER_KINDS = ['system', 'admin', 'normal'] as const;
export type UserKind = (typeof USER_KINDS)[number];

/**
 * HTTP methods a webhook subscription may be delivered with (issue #87, plan §4.1).
 *
 * `POST` is the default and the shape every receiver understands; the rest exist because the
 * issue explicitly asks for more than POST (a `GET` "ping" style endpoint, or a `PUT`/`PATCH`
 * upsert against a REST API). A `GET` carries its payload as query parameters rather than a
 * body, and therefore cannot carry an HMAC **body** signature — a limitation the delivery
 * phase surfaces rather than hides.
 *
 * Unlike the free-TEXT vocabularies above (`wishlist.priority`, `item_relations.kind`) this one
 * is a hard DB CHECK on `webhooks.method`: the set is fixed by HTTP, not by Gubbins, so there is
 * no forward-compatibility case for letting a newer peer mint a value the deliverer could not
 * issue anyway.
 */
export const WEBHOOK_METHODS = ['POST', 'GET', 'PUT', 'PATCH'] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

/**
 * The five persisted purchase-order statuses (issue #605), in lifecycle order.
 *
 * Only `DRAFT` and `CANCELLED` are user-set authoritative states; the middle three are a
 * derived snapshot of received-vs-ordered recomputed by `po-status.ts` and written back so a
 * peer reading the row sees the same state without re-deriving it.
 *
 * Lives here, rather than as a bare union beside `PurchaseOrderRow`, because
 * `purchase_orders.status` carries a hard DB CHECK: with nothing to interpolate, the DDL
 * restated the list by hand, so widening the union type-checked cleanly and then aborted the
 * first write that persisted the new value.
 */
export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/**
 * How a recorded supplier-part price point came to be (issue #605) — a manual edit or a
 * supplier scrape. A hard DB CHECK on `supplier_part_price_history.source`, derived from here
 * for the reason given on {@link PURCHASE_ORDER_STATUSES}.
 */
export const PRICE_HISTORY_SOURCES = ['MANUAL', 'SCRAPE'] as const;
export type PriceHistorySource = (typeof PRICE_HISTORY_SOURCES)[number];

/**
 * How an item's custom-field value is held (issue #605): `literal` — the value stored on the
 * row — or `inherit`, which defers to the location ancestry's offer and therefore stores no
 * value of its own.
 *
 * A hard DB CHECK on `item_field_values.mode`, derived from here for the reason given on
 * {@link PURCHASE_ORDER_STATUSES}. Note the column carries a *second*, coupled CHECK —
 * `mode <> 'inherit' OR value IS NULL` — so a third mode is not a one-line addition: it needs
 * a decision about whether it, too, must leave `value` NULL.
 */
export const FIELD_VALUE_MODES = ['literal', 'inherit'] as const;
export type FieldValueMode = (typeof FIELD_VALUE_MODES)[number];

/**
 * Fixed, well-known identifier for the seeded **System** user (issue #79, plan §2.2).
 *
 * Like {@link UNASSIGNED_LOCATION_ID} it is a deliberately *constant* UUIDv4 — never
 * `crypto.randomUUID()` — because every device must agree on it: `item_history.actor_user_id`
 * defaults to this id, and the FK's `ON DELETE SET DEFAULT` re-points a deleted user's ledger
 * rows here, so a per-device id would dangle the moment a history row crossed a sync.
 */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000010';

/** Sign-in handle of the seeded System user. Never used to sign in — System has no password. */
export const SYSTEM_USER_USERNAME = 'system';

/** Display name of the seeded System user, as it appears against an automated ledger entry. */
export const SYSTEM_USER_DISPLAY_NAME = 'System';

/**
 * Seeded `description` for the System user (issue #430). Stored verbatim rather than composed
 * in the UI so a fresh database and this constant can never drift; the display layer renders it
 * translated while it still equals this shipped value (see `builtin-user-labels.ts`), exactly as
 * a built-in role's description does.
 */
export const SYSTEM_USER_DESCRIPTION =
  'The automated actor Gubbins signs its own actions as — scheduled maintenance, imports and sync reconciliation. It never signs in and has no password.';

/**
 * Fixed, well-known identifier for the seeded **Admin** user (issue #79, plan §2.2). Constant
 * for the same reason as {@link SYSTEM_USER_ID}: with the users module off and nobody signed in,
 * every action in the app is attributed to this id, so it must resolve identically on every
 * device. (A device that switched the module off while somebody was signed in keeps attributing
 * to that person — see `features/users/authority-refresh.ts`, issue #630.)
 */
export const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000011';

/** Sign-in handle of the seeded Admin user. */
export const ADMIN_USER_USERNAME = 'admin';

/** Display name of the seeded Admin user. */
export const ADMIN_USER_DISPLAY_NAME = 'Admin';

/** Seeded `description` for the Admin user (issue #430). See {@link SYSTEM_USER_DESCRIPTION}. */
export const ADMIN_USER_DESCRIPTION =
  'Full access to everything. This is the identity single-user mode transparently acts as when the Users module is switched off.';

/**
 * The seeded users that may never be deleted, disabled, renamed or re-roled (plan §2.2).
 * Enforced by SQL trigger *and* at the repository layer — a guard that only exists in a React
 * component is not a guard.
 */
export const BUILTIN_USER_IDS = [SYSTEM_USER_ID, ADMIN_USER_ID] as const;
