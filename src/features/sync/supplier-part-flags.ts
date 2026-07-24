/**
 * The `supplier_parts` "one flag per item" invariant, shared across every sync write path
 * (issues #157 / #192).
 *
 * `supplier_parts` carries two independent one-of-N boolean flags per item — `is_preferred`
 * (valuation) and `is_price_source` (which supplier a price refresh fetches) — each of which the
 * schema now guards with a partial unique index (`… WHERE is_preferred = 1` / `… = 1`). Per-row
 * last-write-wins cannot see across rows, so any path that writes a *foreign* snapshot's
 * supplier-part rows can present two rows sharing a flag for one item. Left unrepaired that either
 * trips the index (`restoreSnapshot`'s `ON CONFLICT(id)` upsert aborts the whole restore) or, worse,
 * silently collapses a row (`buildCloneStatements`' `INSERT OR REPLACE` deletes the conflicting row
 * wholesale). This module reduces a set of rows to one deterministic winner per (item, flag) before
 * they are written; the reconcile engine reuses {@link SUPPLIER_PART_FLAG_COLUMNS} and
 * {@link flagWinner} for its own cross-row repair of the delta path.
 */
import type { SqlRow } from '@/db/rpc/driver';

/**
 * The one-of-N flag columns, each of which must have at most one row set per item. Fixed code
 * literals — never derived from row data — so a caller may safely splice one into a SQL identifier.
 */
export const SUPPLIER_PART_FLAG_COLUMNS = ['is_preferred', 'is_price_source'] as const;

/** A row competing to keep a one-of-N flag. */
export interface FlagRanked {
  readonly id: string;
  readonly updatedAt: number;
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

/**
 * Whether `a` should keep a one-of-N flag over `b`: newest `updated_at`, an exact tie broken by the
 * lexicographically smaller id. The tiebreak is device-independent by design — both sides of a sync
 * (and every write path) must reach the same verdict without reference to which row is "local".
 */
export function flagWinner<T extends FlagRanked>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * Return a copy of `rows` in which each one-of-N supplier-part flag has at most one winner per
 * item; every other row that carried the flag is cleared to 0. Rows without either flag pass
 * through untouched. Pure — the input is never mutated.
 */
export function dedupeSupplierPartFlags(rows: readonly SqlRow[]): SqlRow[] {
  const result = rows.map((r) => ({ ...r }));
  for (const column of SUPPLIER_PART_FLAG_COLUMNS) {
    const winnerByItem = new Map<string, FlagRanked>();
    for (const r of result) {
      if (num(r[column]) !== 1) continue;
      const candidate: FlagRanked = { id: String(r.id), updatedAt: num(r.updated_at) };
      const held = winnerByItem.get(String(r.item_id));
      if (!held || flagWinner(candidate, held) === candidate) winnerByItem.set(String(r.item_id), candidate);
    }
    for (const r of result) {
      if (num(r[column]) !== 1) continue;
      if (String(r.id) !== winnerByItem.get(String(r.item_id))!.id) r[column] = 0;
    }
  }
  return result;
}

/**
 * The (column, item) pairs a `dedupeSupplierPartFlags` result pins — one per item that keeps a
 * flag. A **non-destructive** write path (restore, clone-salvage) uses these to clear the same flag
 * on any *other* local row for that item before it writes the winner, mirroring the app's
 * demote-then-set so the partial unique index is free when the winner's write lands.
 */
export function supplierPartFlagClears(rows: readonly SqlRow[]): { column: string; itemId: string }[] {
  const clears: { column: string; itemId: string }[] = [];
  for (const column of SUPPLIER_PART_FLAG_COLUMNS) {
    const items = new Set<string>();
    for (const r of rows) if (num(r[column]) === 1) items.add(String(r.item_id));
    for (const itemId of items) clears.push({ column, itemId });
  }
  return clears;
}
