/**
 * The audit record a last-write-wins merge leaves behind (issue #487).
 *
 * Editing an item records every structured field it touched, with the value before and after,
 * in an `ATTRIBUTES_CHANGED` entry (issue #144). A **sync merge** used to record nothing: §7.3
 * reconciliation applies the winning `items` row straight against the table, so when two devices
 * edited the same item offline the losing side's values were discarded silently — the ledger
 * showed each device's own edit and nothing saying one of them had since been overwritten. On the
 * device that lost, the log read as though its edit still stood.
 *
 * This module is the other half of #144's motivation: given the losing local row and the winning
 * remote one, it names the fields the merge overwrote and the values it discarded, in the same
 * `{field, from, to}` shape the edit path writes, so one reader handles both.
 *
 * Pure and database-free — the reconcile engine builds the records, `applyPlan` writes them.
 */
import type { SqlRow, SqlValue } from '@/db/rpc/driver';
import { uuidv5 } from '@/lib/derived-uuid';
import { fromStoredMoney } from '@/lib/money';

/** One field a merge overwrote: its name, the value discarded, and the value adopted. */
export interface FieldChange {
  readonly field: string;
  readonly from: SqlValue;
  readonly to: SqlValue;
}

interface AuditedColumn {
  /** The `items` column as it is stored and as it travels in a snapshot. */
  readonly column: string;
  /** The camelCase field name a machine consumer reads out of the metadata. */
  readonly field: string;
  /** British-English prose for the entry's note. */
  readonly label: string;
  /** A money column, stored in integer micro-units and reported in major units (issue #286). */
  readonly money?: true;
}

/**
 * The `items` columns whose loss is worth recording — deliberately the **same set** the edit
 * path audits, so a value that raises a ledger entry when a person changes it also raises one
 * when a merge discards it.
 *
 * That set is every structured attribute: identity, classification, price, reordering,
 * perishability, provenance, lifecycle dates and physical measurements, plus the three that have
 * their own actions on the edit path (`name` → `RENAMED`, `tracking_mode` → `TRACKING_CHANGED`,
 * `condition` → `CONDITION_CHANGED`). A merge writes one entry rather than four, so they arrive
 * here as ordinary fields.
 *
 * What stays out is what the edit path leaves silent, for the same reasons: free-form prose
 * (`description`, `notes`, `operational_metadata`), whose before/after copy would bloat a ledger
 * that syncs to every device for a field nobody audits by value; and the reporting preferences
 * (`is_favourite`, `is_unlimited`, `dead_stock_mode`). Out too are the columns no LWW upsert
 * decides: `quantity` and `current_net_value` are merged by the Delta-CRDTs (`nonLwwColumns`),
 * and `location_id`, `parent_id` and `is_active` are moved by their own dedicated paths.
 *
 * Every audited column is bounded — a line of text, a number or a date — so a record of all of
 * them together stays far inside the `metadata` payload limit even at its worst.
 */
const AUDITED_COLUMNS: readonly AuditedColumn[] = [
  { column: 'name', field: 'name', label: 'name' },
  { column: 'tracking_mode', field: 'trackingMode', label: 'tracking mode' },
  { column: 'condition', field: 'condition', label: 'condition' },
  { column: 'category_id', field: 'categoryId', label: 'category' },
  { column: 'mpn', field: 'mpn', label: 'MPN' },
  { column: 'manufacturer', field: 'manufacturer', label: 'manufacturer' },
  { column: 'barcode', field: 'barcode', label: 'barcode' },
  { column: 'serial_number', field: 'serialNumber', label: 'serial number' },
  { column: 'unit_cost', field: 'unitCost', label: 'unit cost', money: true },
  {
    column: 'cost_per_unit_of_measure',
    field: 'costPerUnitOfMeasure',
    label: 'cost per unit of measure',
    money: true,
  },
  { column: 'expiry_date', field: 'expiryDate', label: 'expiry date' },
  { column: 'batch_number', field: 'batchNumber', label: 'batch number' },
  { column: 'lot_number', field: 'lotNumber', label: 'lot number' },
  { column: 'reorder_point', field: 'reorderPoint', label: 'reorder point' },
  {
    column: 'reorder_gauge_percent',
    field: 'reorderGaugePercent',
    label: 'reorder gauge percentage',
  },
  { column: 'reorder_qty', field: 'reorderQty', label: 'reorder quantity' },
  { column: 'acquired_at', field: 'acquiredAt', label: 'acquired date' },
  { column: 'warranty_expires_at', field: 'warrantyExpiresAt', label: 'warranty expiry' },
  { column: 'purchase_price', field: 'purchasePrice', label: 'purchase price', money: true },
  { column: 'depreciation_months', field: 'depreciationMonths', label: 'depreciation period' },
  { column: 'weight', field: 'weight', label: 'weight' },
  { column: 'width', field: 'width', label: 'width' },
  { column: 'height', field: 'height', label: 'height' },
  { column: 'depth', field: 'depth', label: 'depth' },
  { column: 'current_value', field: 'currentValue', label: 'current value', money: true },
];

/** @internal Exported so a drift test can hold this set against the edit path's tracked fields. */
export const AUDITED_ITEM_FIELDS: readonly string[] = AUDITED_COLUMNS.map((c) => c.field);

/**
 * A snapshot value as the ledger records it: `bigint` narrowed to `number` (a snapshot read can
 * hand back either, and `JSON.stringify` throws on the former), `undefined` collapsed to `null`.
 */
function plain(value: unknown): SqlValue {
  if (typeof value === 'bigint') return Number(value);
  return (value ?? null) as SqlValue;
}

/** A money column in the major units the item DTO and the edit path's audit both speak (#286). */
function major(value: unknown): SqlValue {
  const stored = plain(value);
  return typeof stored === 'number' ? fromStoredMoney(stored) : null;
}

/**
 * The audited fields in which the winning row differs from the losing one — what the merge is
 * about to overwrite, and what it discards doing so.
 *
 * Only columns **present on the winner** are compared. `applyPlan` builds its upsert as
 * `SET col = excluded.col` over exactly those columns, so a column an older peer's schema does
 * not carry is not written at all; reading its absence as "overwritten to nothing" would record
 * a loss that never happens. Values are compared as strings for the same reason `rowsDiffer`
 * does: a snapshot round-trip can change a number's runtime type without changing the value.
 */
export function overwrittenFields(losing: SqlRow, winning: SqlRow): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const { column, field, money } of AUDITED_COLUMNS) {
    if (!(column in winning) || !(column in losing)) continue;
    const from = losing[column];
    const to = winning[column];
    if (String(from ?? '') === String(to ?? '')) continue;
    changes.push(
      money ? { field, from: major(from), to: major(to) } : { field, from: plain(from), to: plain(to) },
    );
  }
  return changes;
}

/** The labels, in registry order, for the fields a set of changes names. */
export function labelsFor(changes: readonly FieldChange[]): string[] {
  const named = new Set(changes.map((c) => c.field));
  return AUDITED_COLUMNS.filter((c) => named.has(c.field)).map((c) => c.label);
}

/** The British-English prose for an overwrite entry's note. */
export function overwriteNote(labels: readonly string[]): string {
  return `A newer edit from another device overwrote this device's ${labels.join(', ')}.`;
}

/**
 * The naming authority for a merge-overwrite entry's derived id. A fixed, arbitrary UUID: it
 * only has to be stable and distinct from every other namespace, never meaningful.
 */
const MERGE_AUDIT_NAMESPACE = '6b2f5f4c-9a1d-5d63-9d3f-1c0b5a7e4d21';

/**
 * The **deterministic** id for the entry recording that `itemId`'s local version, stamped
 * `losingUpdatedAt`, lost to a remote version stamped `winningUpdatedAt`.
 *
 * `item_history` reconciles by union-of-id, so a random id would not survive a replay: the same
 * merge re-run — because a sync failed after applying but before the watermark advanced, or
 * because a peer pulled the same pair of versions — would append a second entry saying the same
 * thing, once per replay. Deriving the id from the three facts that identify the overwrite makes
 * the repeat an `INSERT OR IGNORE` no-op instead. A *different* local version losing later is a
 * different overwrite and gets its own id, exactly as `conflictId` keys a conflict by the version
 * it discarded.
 */
export function mergeOverwriteId(
  itemId: string,
  losingUpdatedAt: number,
  winningUpdatedAt: number,
): Promise<string> {
  return uuidv5(
    `item-merge-overwrite|${itemId}|${losingUpdatedAt}|${winningUpdatedAt}`,
    MERGE_AUDIT_NAMESPACE,
  );
}
