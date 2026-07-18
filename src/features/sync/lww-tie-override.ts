/**
 * Lab-only reproduction seam for the `sync-lww-tie` flag (see `src/features/lab/lab-flags.ts`).
 *
 * There is a known bug where a tied `updated_at` between the local and incoming remote copy
 * of a row still resolves to `REMOTE_WINS` (§7.3 `resolveLww` sends ties to the remote), so
 * `applyPlan` re-upserts the row even when nothing meaningful changed.
 *
 * That re-upsert is what turns a harmless no-op into churn, via the auto-stamp trigger (see
 * `updatedAtTrigger` in `v1-initial.ts`). Its guard is `WHEN NEW.updated_at = OLD.updated_at`,
 * which normally means "the caller didn't set `updated_at`, so stamp it now" — and an ordinary
 * sync upsert is exempt precisely because it *does* set the column, to a value that differs.
 * On a tie, though, the engine explicitly sets `updated_at` to the value the row already held,
 * which the trigger cannot distinguish from not setting it at all: the guard matches, and the
 * row is stamped `MAX(now, OLD.updated_at + 1)` anyway. This device now looks strictly newer,
 * so the next round pushes it back — and two devices ping-pong an unchanged row indefinitely.
 *
 * A genuine tie is rare in practice (it needs two clocks to land on the exact same millisecond),
 * so reproducing it on demand for investigation means forcing one. This pure transform does
 * that: it rewrites every incoming remote row that also exists locally so its `updated_at`
 * exactly matches the local row's, in memory only — nothing is written to either database, and
 * the tie-breaking rule in `lww.ts` is untouched.
 */
import { SYNC_TABLES } from '@/db/repositories';
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
