/**
 * Building the user-facing conflict records the reconcile engine surfaces (issue #72).
 *
 * Pure and transport-free: given the losing local row and (for an update) the winning
 * remote row, it produces the {@link SyncConflict} the orchestrator carries out of the
 * sync so the UI can present and, on request, restore the discarded version. The detection
 * *decision* (was there a genuine concurrent collision?) lives in `reconcile`; this module
 * only shapes the record — the deterministic dedupe id and the human-friendly label — so
 * both can be unit-tested in isolation.
 */
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncConflict, SyncTable } from './types';

/**
 * Columns that are NOT resolved by Last-Write-Wins and therefore must be excluded from
 * collision handling entirely (issue #72). On the `items` row, `current_net_value` is merged
 * by the §7.3 delta-CRDT (see `delta-crdt.ts`: it "must NEVER be resolved by Last-Write-Wins")
 * and `quantity` is a trigger-derived SUM of the per-location `item_stock` ledger (Phase 25).
 * Neither is authoritative on the items row, so a difference in them is not a lost edit — and
 * restoring them would clobber the CRDT-merged value or be silently undone by the recompute
 * trigger. Detection, the diff view and the restore-UPDATE all consult this set.
 */
export const NON_LWW_COLUMNS: Partial<Record<SyncTable, ReadonlySet<string>>> = {
  items: new Set(['current_net_value', 'quantity']),
};

/** The non-LWW columns for a table (empty when none), for conflict detection/diff/restore. */
export function nonLwwColumns(table: SyncTable): ReadonlySet<string> {
  return NON_LWW_COLUMNS[table] ?? EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Columns tried, in order, for a human-friendly row label before falling back to the id. */
const LABEL_COLUMNS = ['name', 'title', 'label', 'alias', 'display_name', 'username', 'note'] as const;

/**
 * A short, human-friendly label for a row, captured at detect time from the losing local
 * version so the review UI can name the conflict ("Cordless drill") without a DB join — and
 * so it stays meaningful even if the row later changes or is removed. Falls back to a
 * shortened id when the row carries no obvious name-like column.
 */
export function entityLabelFor(tableName: SyncTable, row: SqlRow): string {
  for (const col of LABEL_COLUMNS) {
    const value = row[col];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return `${tableName} ${String(row.id).slice(0, 8)}`;
}

/**
 * Deterministic id for a conflict: the losing local version, keyed by its `updated_at`.
 * Re-detecting the *same* discarded version on a later sync yields the same id (so it
 * de-duplicates in the store), while a *fresh* local edit that later loses gets a new id.
 */
export function conflictId(tableName: SyncTable, rowId: string, localUpdatedAt: number): string {
  return `${tableName}:${rowId}:${localUpdatedAt}`;
}

/** Shape a {@link SyncConflict} from the losing local row and the winning remote row (or null for a delete). */
export function buildConflict(
  tableName: SyncTable,
  localRow: SqlRow,
  remoteRow: SqlRow | null,
  detectedAt: number,
): SyncConflict {
  const rowId = String(localRow.id);
  return {
    id: conflictId(tableName, rowId, Number(localRow.updated_at)),
    tableName,
    rowId,
    kind: remoteRow === null ? 'DELETE' : 'UPDATE',
    localVersion: localRow,
    remoteVersion: remoteRow,
    entityLabel: entityLabelFor(tableName, localRow),
    detectedAt,
  };
}
