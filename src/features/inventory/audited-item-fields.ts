/**
 * The registry of item fields the Activity Ledger audits by value (issues #144, #487, #486).
 *
 * One entry per `items` column whose before/after values are worth recording, carrying the facts
 * every consumer of that record needs:
 *
 *  - `column` — the raw `items` column, as a snapshot row carries it. The sync merge audit works
 *    on snapshot rows and never goes through `ItemRepository`, so it needs the column name.
 *  - `field` — the camelCase name written into the ledger entry's `metadata.changes[].field`.
 *  - `label` — British-English prose for the entry's *note* ("Changed unit cost, barcode.").
 *  - `labelKey` — the translated, sentence-case label the Activity Log renders beside the values.
 *  - `kind` — what the value **is**, so a reader can render £4.00 rather than 4, a category's name
 *    rather than its id, and "Not set" rather than a blank.
 *
 * It lives here rather than beside either reader because both write the same record: a person
 * editing the item (`ItemRepository.update` → `ATTRIBUTES_CHANGED`) and a last-write-wins merge
 * discarding a value (`merge-audit.ts` → `MERGE_OVERWRITTEN`). One registry means a field cannot
 * be audited by one path and unknown to the other, and `merge-audit-drift.test.ts` holds the set
 * against both the edit path and the live `items` schema.
 */
import type { MessageKey } from '@/features/i18n';

/**
 * What an audited value is, so the Activity Log can render it as the user entered it rather than
 * as it is stored. Every kind names the *stored* representation, which is what the ledger carries.
 */
export type ItemFieldValueKind =
  /** A line of free text — rendered verbatim. */
  | 'text'
  /**
   * A monetary amount in **major** units. The column stores micro-units, but both audit paths
   * record the major units the item DTO speaks (issue #286), so a reader formats it directly.
   */
  | 'money'
  /** A whole count (a reorder point, a depreciation period in months). */
  | 'count'
  /** A percentage written 0..100, as the reorder gauge floor is stored. */
  | 'percent'
  /** A mass in grams, rendered in the user's chosen weight unit. */
  | 'weight'
  /** A length in millimetres, rendered in the user's chosen dimension unit. */
  | 'dimension'
  /** A day-grained UNIX-ms instant (stored at midnight UTC via the `date-input` seam). */
  | 'timestamp'
  /** A day-grained ISO calendar date string, `YYYY-MM-DD`. */
  | 'isoDate'
  /** A category id, resolved to that category's name. */
  | 'category'
  /** A `TrackingMode` enum member. */
  | 'trackingMode'
  /** A `Condition` enum member. */
  | 'condition';

/** One audited item field: how it is stored, what it is called, and what its value means. */
export interface AuditedItemField {
  /** The `items` column as it is stored and as it travels in a snapshot. */
  readonly column: string;
  /** The camelCase field name a machine consumer reads out of the metadata. */
  readonly field: string;
  /** British-English prose for the entry's note. */
  readonly label: string;
  /** Catalog key for the sentence-case label the Activity Log shows beside the values. */
  readonly labelKey: MessageKey;
  /** What the recorded value is, so a reader can format it. */
  readonly kind: ItemFieldValueKind;
}

/**
 * The audited fields, in the order the Activity Log lists them — identity and classification
 * first, then price, reordering, perishability, provenance and measurements, so a multi-field
 * edit reads in the same order every time rather than in whatever order the form submitted.
 *
 * Three of them (`name`, `trackingMode`, `condition`) have their own history action on the edit
 * path; a merge writes one entry for the whole overwrite, so they arrive here as ordinary fields.
 *
 * What stays out is what the edit path leaves silent: free-form prose (`description`, `notes`,
 * `operational_metadata`), whose before/after copy would bloat a ledger that syncs to every
 * device, and the reporting preferences (`is_favourite`, `is_unlimited`, `dead_stock_mode`). Out
 * too are the columns no last-write-wins upsert decides — `quantity` and `current_net_value` are
 * merged by the §7.3 Delta-CRDTs, and `location_id`, `parent_id` and `is_active` are moved by
 * their own dedicated paths.
 *
 * Every audited value is bounded — a line of text, a number or a date — so a record of all of them
 * together stays far inside the `metadata` payload limit even at its worst.
 */
export const AUDITED_ITEM_COLUMNS: readonly AuditedItemField[] = [
  {
    column: 'name',
    field: 'name',
    label: 'name',
    labelKey: 'inventory.activityLog.field.name',
    kind: 'text',
  },
  {
    column: 'tracking_mode',
    field: 'trackingMode',
    label: 'tracking mode',
    labelKey: 'inventory.activityLog.field.trackingMode',
    kind: 'trackingMode',
  },
  {
    column: 'condition',
    field: 'condition',
    label: 'condition',
    labelKey: 'inventory.activityLog.field.condition',
    kind: 'condition',
  },
  {
    column: 'category_id',
    field: 'categoryId',
    label: 'category',
    labelKey: 'inventory.activityLog.field.categoryId',
    kind: 'category',
  },
  {
    column: 'mpn',
    field: 'mpn',
    label: 'MPN',
    labelKey: 'inventory.activityLog.field.mpn',
    kind: 'text',
  },
  {
    column: 'manufacturer',
    field: 'manufacturer',
    label: 'manufacturer',
    labelKey: 'inventory.activityLog.field.manufacturer',
    kind: 'text',
  },
  {
    column: 'barcode',
    field: 'barcode',
    label: 'barcode',
    labelKey: 'inventory.activityLog.field.barcode',
    kind: 'text',
  },
  {
    column: 'serial_number',
    field: 'serialNumber',
    label: 'serial number',
    labelKey: 'inventory.activityLog.field.serialNumber',
    kind: 'text',
  },
  {
    column: 'unit_cost',
    field: 'unitCost',
    label: 'unit cost',
    labelKey: 'inventory.activityLog.field.unitCost',
    kind: 'money',
  },
  {
    column: 'cost_per_unit_of_measure',
    field: 'costPerUnitOfMeasure',
    label: 'cost per unit of measure',
    labelKey: 'inventory.activityLog.field.costPerUnitOfMeasure',
    kind: 'money',
  },
  {
    column: 'expiry_date',
    field: 'expiryDate',
    label: 'expiry date',
    labelKey: 'inventory.activityLog.field.expiryDate',
    kind: 'timestamp',
  },
  {
    column: 'batch_number',
    field: 'batchNumber',
    label: 'batch number',
    labelKey: 'inventory.activityLog.field.batchNumber',
    kind: 'text',
  },
  {
    column: 'lot_number',
    field: 'lotNumber',
    label: 'lot number',
    labelKey: 'inventory.activityLog.field.lotNumber',
    kind: 'text',
  },
  {
    column: 'reorder_point',
    field: 'reorderPoint',
    label: 'reorder point',
    labelKey: 'inventory.activityLog.field.reorderPoint',
    kind: 'count',
  },
  {
    column: 'reorder_gauge_percent',
    field: 'reorderGaugePercent',
    label: 'reorder gauge percentage',
    labelKey: 'inventory.activityLog.field.reorderGaugePercent',
    kind: 'percent',
  },
  {
    column: 'reorder_qty',
    field: 'reorderQty',
    label: 'reorder quantity',
    labelKey: 'inventory.activityLog.field.reorderQty',
    kind: 'count',
  },
  {
    column: 'acquired_at',
    field: 'acquiredAt',
    label: 'acquired date',
    labelKey: 'inventory.activityLog.field.acquiredAt',
    kind: 'isoDate',
  },
  {
    column: 'warranty_expires_at',
    field: 'warrantyExpiresAt',
    label: 'warranty expiry',
    labelKey: 'inventory.activityLog.field.warrantyExpiresAt',
    kind: 'isoDate',
  },
  {
    column: 'purchase_price',
    field: 'purchasePrice',
    label: 'purchase price',
    labelKey: 'inventory.activityLog.field.purchasePrice',
    kind: 'money',
  },
  {
    column: 'depreciation_months',
    field: 'depreciationMonths',
    label: 'depreciation period',
    labelKey: 'inventory.activityLog.field.depreciationMonths',
    kind: 'count',
  },
  {
    column: 'weight',
    field: 'weight',
    label: 'weight',
    labelKey: 'inventory.activityLog.field.weight',
    kind: 'weight',
  },
  {
    column: 'width',
    field: 'width',
    label: 'width',
    labelKey: 'inventory.activityLog.field.width',
    kind: 'dimension',
  },
  {
    column: 'height',
    field: 'height',
    label: 'height',
    labelKey: 'inventory.activityLog.field.height',
    kind: 'dimension',
  },
  {
    column: 'depth',
    field: 'depth',
    label: 'depth',
    labelKey: 'inventory.activityLog.field.depth',
    kind: 'dimension',
  },
  {
    column: 'current_value',
    field: 'currentValue',
    label: 'current value',
    labelKey: 'inventory.activityLog.field.currentValue',
    kind: 'money',
  },
];

/** @internal Exported so a drift test can hold this set against the edit path's tracked fields. */
export const AUDITED_ITEM_FIELDS: readonly string[] = AUDITED_ITEM_COLUMNS.map((c) => c.field);

const BY_FIELD = new Map(AUDITED_ITEM_COLUMNS.map((c) => [c.field, c]));

/**
 * The registry entry for a camelCase field name, or `undefined` for one this build does not know.
 *
 * An unknown field is expected rather than exceptional: `item_history` unions across devices, so a
 * newer peer can sync an entry naming a column this build has never heard of (§7.3). Callers show
 * it as raw text rather than dropping it — the ledger is immutable and the record is still true.
 */
export function auditedItemField(field: string): AuditedItemField | undefined {
  return BY_FIELD.get(field);
}
