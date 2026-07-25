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
 *
 * Issue #188 extends the same reasoning down the ledger: `stock_batches.quantity` is now merged
 * by the discrete-stock Delta-CRDT (replaying the `stock_deltas` ledger), and `item_stock.quantity`
 * is the trigger-derived SUM of it. So a divergence in either is a converged value, not a lost
 * edit — surfacing it as a conflict, or restoring the losing side's quantity, would misreport the
 * merge and be undone by the recompute triggers.
 */
export const NON_LWW_COLUMNS: Partial<Record<SyncTable, ReadonlySet<string>>> = {
  items: new Set(['current_net_value', 'quantity']),
  item_stock: new Set(['quantity']),
  stock_batches: new Set(['quantity']),
};

/** The non-LWW columns for a table (empty when none), for conflict detection/diff/restore. */
export function nonLwwColumns(table: SyncTable): ReadonlySet<string> {
  return NON_LWW_COLUMNS[table] ?? EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Tables whose Last-Write-Wins outcome is **never** a user-facing "one of your edits was
 * overwritten" conflict (issue #72), however genuinely concurrent it was.
 *
 * {@link NON_LWW_COLUMNS} above excuses a *column* because it isn't resolved by LWW. This set
 * excuses a *table* for the opposite reason: LWW is exactly the promised behaviour, and reporting
 * it as a lost edit would contradict what the user was told.
 *
 * `settings` — the shared copy of the preferences that travel between devices (issue #382). "The
 * device that changed it most recently wins" is the documented rule and the whole point, so
 * changing your theme on a phone after changing it on a desktop is a *resolved* preference, not a
 * casualty. Surfacing it would also be actively harmful: it fires on routine use, the review UI has
 * no name-like column to label the row with, it evicts real inventory conflicts from a capped
 * store, and "Use my version" would rewrite a row the live store has *already* adopted the winner
 * of — so the next sync would re-adopt the restored value and flip the user's setting back.
 */
export const CONFLICT_EXEMPT_TABLES: ReadonlySet<SyncTable> = new Set<SyncTable>(['settings']);

/** Whether a losing local row in this table is worth reporting to the user (issue #72). */
export function detectsConflicts(table: SyncTable): boolean {
  return !CONFLICT_EXEMPT_TABLES.has(table);
}

/** Columns tried, in order, for a human-friendly row label before falling back to the id. */
const LABEL_COLUMNS = ['name', 'title', 'label', 'alias', 'display_name', 'username', 'note'] as const;

/**
 * A short, human-friendly label for a row, captured at detect time from the losing local
 * version so the review UI can name the conflict ("Cordless drill") without a DB join — and
 * so it stays meaningful even if the row later changes or is removed. Falls back to a
 * shortened id when the row carries no obvious name-like column.
 *
 * @internal Exported for unit tests only.
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
 *
 * @internal Exported for unit tests only.
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
