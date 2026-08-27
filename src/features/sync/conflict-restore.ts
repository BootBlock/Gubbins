/**
 * Restoring the discarded side of a sync collision (issue #72).
 *
 * When the user reviews a {@link SyncConflict} and chooses "restore my version", we write the
 * captured losing local row back into its table. The row's `updated_at` auto-stamp trigger
 * re-stamps it to *now*, so it becomes the newest version and wins the next sync's LWW —
 * propagating the user's recovered edit to every peer. For a `DELETE` collision (a peer
 * removed a row we'd edited) the same UPSERT resurrects the row, and its stale local
 * tombstone is cleared so the snapshot no longer carries the deletion.
 *
 * The stored versions are in *snapshot* form (base64-encoded BLOBs), exactly like the sync
 * engine's own upserts, so this decodes them the same way before the DB write.
 */
import { buildSchemaDictionary } from './schema-dictionary';
import { decodeRowForTable } from './blob-codec';
import { nonLwwColumns } from './conflict-detect';
import { assertPermissions } from '@/features/users/assert-permission';
import { currentAuthority } from '@/features/users/current-authority';
import type { IDatabaseDriver, SqlStatement, SqlValue } from '@/db/rpc/driver';
import type { SyncConflict } from './types';

/**
 * Re-apply a conflict's discarded local version as a fresh local edit (so it wins the next
 * sync). Throws if the row can no longer be written (e.g. a parent it referenced is gone) —
 * the caller surfaces that to the user rather than silently dropping the restore.
 *
 * Gated on `sync:write` (issue #429). Unlike the sync pass itself — which is device replication
 * and deliberately ungated (see `sync-engine.ts`) — this is a user *choosing* to overturn a
 * merge outcome: it resurrects a row a peer deleted, or overwrites the version every other
 * device agreed on, and the re-stamped `updated_at` then pushes that decision to all of them.
 * It composes its own SQL and hands it to the driver, so `BaseRepository.assertPermission`
 * never sees it and the check has to live here.
 */
export async function restoreConflictVersion(driver: IDatabaseDriver, conflict: SyncConflict): Promise<void> {
  assertPermissions(currentAuthority(), ['sync:write']);

  const dictionary = await buildSchemaDictionary(driver, [conflict.tableName]);
  const columns = dictionary[conflict.tableName] ?? Object.keys(conflict.localVersion);

  // Decode snapshot-form BLOBs back to bytes and keep only columns the live schema has;
  // re-stamp `updated_at` by omitting it so the auto-stamp trigger sets it to now.
  const row = decodeRowForTable(conflict.tableName, conflict.localVersion);
  const cols = columns.filter((c) => c in row && c !== 'updated_at');
  // The table's non-LWW columns (CRDT gauge value, trigger-derived quantity) stay in the INSERT
  // — so a resurrected row still satisfies its NOT NULL / CHECK constraints — but are excluded
  // from the UPDATE, so restoring over an existing row never clobbers the merged/derived value.
  const skipUpdate = nonLwwColumns(conflict.tableName);
  const updates = cols
    .filter((c) => c !== 'id' && !skipUpdate.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  const statements: SqlStatement[] = [
    {
      sql:
        `INSERT INTO ${conflict.tableName} (${cols.join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${updates};`,
      params: cols.map((c) => row[c] as SqlValue),
    },
  ];

  // A resurrected row must not keep a local tombstone that would re-propagate its deletion.
  if (conflict.kind === 'DELETE') {
    statements.push({
      sql: 'DELETE FROM tombstones WHERE table_name = ? AND id = ?;',
      params: [conflict.tableName, conflict.rowId],
    });
  }

  await driver.transaction(statements);
}
