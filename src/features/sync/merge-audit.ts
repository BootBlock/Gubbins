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
 * The set of fields it audits, and the prose that names each one, come from the shared
 * `audited-item-fields` registry, which the Activity Log reads too, so the two entries a user sees
 * name the same field the same way. `ItemRepository.update` cannot read it — the db layer holds no
 * feature-layer imports — so it passes its own labels inline; what holds the two *sets* together is
 * `merge-audit-drift.test.ts`, which drives every mutable field the edit path takes and compares
 * what it audited against this registry.
 *
 * Pure and database-free — the reconcile engine builds the records, `applyPlan` writes them.
 */
import type { SqlRow, SqlValue } from '@/db/rpc/driver';
import { AUDITED_ITEM_COLUMNS } from '@/features/inventory/audited-item-fields';
import { uuidv5 } from '@/lib/derived-uuid';
import { fromStoredMoney } from '@/lib/money';

/** One field a merge overwrote: its name, the value discarded, and the value adopted. */
export interface FieldChange {
  readonly field: string;
  readonly from: SqlValue;
  readonly to: SqlValue;
}

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
 * Only columns **both rows carry** are compared. `applyPlan` builds its upsert as
 * `SET col = excluded.col` over exactly the winner's columns, so a column an older peer's schema
 * does not carry is not written at all; reading its absence as "overwritten to nothing" would
 * record a loss that never happens. A column missing from the losing row is skipped for the
 * mirror reason: there is no discarded value to record, so the entry would assert one it never
 * saw. Values are compared as strings for the same reason `rowsDiffer` does: a snapshot
 * round-trip can change a number's runtime type without changing the value.
 */
export function overwrittenFields(losing: SqlRow, winning: SqlRow): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const { column, field, kind } of AUDITED_ITEM_COLUMNS) {
    if (!(column in winning) || !(column in losing)) continue;
    const from = losing[column];
    const to = winning[column];
    if (String(from ?? '') === String(to ?? '')) continue;
    changes.push(
      kind === 'money'
        ? { field, from: major(from), to: major(to) }
        : { field, from: plain(from), to: plain(to) },
    );
  }
  return changes;
}

/** The labels, in registry order, for the fields a set of changes names. */
export function labelsFor(changes: readonly FieldChange[]): string[] {
  const named = new Set(changes.map((c) => c.field));
  return AUDITED_ITEM_COLUMNS.filter((c) => named.has(c.field)).map((c) => c.label);
}

/**
 * The British-English prose for an overwrite entry's note.
 *
 * Deliberately written from **no device's** point of view. The entry is authored by the device
 * that lost, but `item_history` is unioned by id, so the row then travels to every peer —
 * including the one whose edit won, where "another device overwrote *this* device's price" is the
 * exact opposite of what happened. The ledger is immutable and the insert is `INSERT OR IGNORE`
 * under a derived id, so a note that is wrong on arrival can never be corrected in place. Which
 * version was discarded is still recorded, as the `from` value of each change.
 */
export function overwriteNote(labels: readonly string[]): string {
  return `Two devices edited this item; the newer edit replaced its ${labels.join(', ')}.`;
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
