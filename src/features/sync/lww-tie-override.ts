/**
 * Lab-only reproduction seam for the `sync-lww-tie` flag (see `src/features/lab/lab-flags.ts`).
 *
 * A tied `updated_at` between the local and incoming remote copy of a row resolves to
 * `REMOTE_WINS` (§7.3 `resolveLww` sends ties to the remote). That once turned a harmless no-op
 * into churn, via the auto-stamp trigger (see `updatedAtTrigger` in `v1-initial.ts`): its guard is
 * `WHEN NEW.updated_at = OLD.updated_at`, which normally means "the caller didn't set `updated_at`,
 * so stamp it now" — and an ordinary sync upsert is exempt precisely because it *does* set the
 * column, to a value that differs. On a tie, though, the engine explicitly set `updated_at` to the
 * value the row already held, which the trigger cannot distinguish from not setting it at all: the
 * guard matched, the row was stamped `MAX(now, OLD.updated_at + 1)`, this device then looked
 * strictly newer, the next round pushed it back — and two devices ping-ponged an unchanged row
 * indefinitely.
 *
 * That churn is now fixed (issue #161): `reconcile` suppresses the tie upsert when the winning row
 * is byte-identical to the one already stored (see `upsertWouldNoOp` in `reconcile.ts`), so a tie is
 * genuinely idempotent — the trigger never fires and nothing is re-pushed. This seam remains a way to
 * force the otherwise-rare tie on demand (two clocks landing on the exact same millisecond), so the
 * idempotent path can be exercised and the fix regression-guarded. This pure transform rewrites every
 * incoming remote row that also exists locally so its `updated_at` exactly matches the local row's, in
 * memory only — nothing is written to either database, and the tie-breaking rule in `lww.ts` is
 * untouched.
 */
import { SYNC_TABLES } from '@/db/repositories/tombstone';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot } from './types';

/**
 * Return a copy of `remote` where every row also present in `local` (matched by table + id)
 * carries the local row's `updated_at` instead of its own. Rows that exist only on one side are
 * left untouched. Pure and side-effect-free — callers decide whether to use the result.
 */
export function forceLwwTies(local: SyncSnapshot, remote: SyncSnapshot): SyncSnapshot {
  const tables: Record<string, readonly SqlRow[]> = { ...remote.tables };

  for (const table of SYNC_TABLES) {
    const remoteRows = remote.tables[table];
    if (!remoteRows || remoteRows.length === 0) continue;
    const localById = new Map((local.tables[table] ?? []).map((row) => [String(row.id), row]));
    if (localById.size === 0) continue;

    tables[table] = remoteRows.map((row) => {
      const localRow = localById.get(String(row.id));
      const localUpdatedAt = localRow?.updated_at;
      if (localUpdatedAt === undefined || localUpdatedAt === row.updated_at) return row;
      return { ...row, updated_at: localUpdatedAt };
    });
  }

  return { ...remote, tables };
}
