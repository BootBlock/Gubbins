/**
 * SettingsRepository (issue #382 — preferences that travel live between devices).
 *
 * The thin SQL glue around the `settings` table: read the shared noticeboard, and upsert the rows
 * this device publishes to it. Every decision about *which* preferences travel, how a value is
 * encoded and whether an incoming one is trustworthy lives in the pure
 * `@/features/settings/settings-sync` seam.
 *
 * Two departures from the usual repository shape, both deliberate:
 *
 *  - **No permission gate.** `assertPermission` guards *inventory* subjects — the things a role can
 *    be denied. A row here is the signed-in user's own interface preference on their own device;
 *    there is no permission key for it and inventing one would let a restricted role be locked out
 *    of its own theme. The Hard Stop still applies, because a row still grows storage.
 *  - **No `delete`, and therefore no tombstone.** A row's id is shared by every device, so deleting
 *    one would withdraw the preference from peers that are still sharing it, not just from here.
 *    Opting a group out stops this device publishing and adopting; it does not reach across to
 *    anyone else's copy. See the wiki page for what that means for the user.
 */
import { BaseRepository } from './base';
import { settingRowId } from '@/features/settings/settings-sync';
import type { SettingRow, SettingUpsert } from './types';

export class SettingsRepository extends BaseRepository {
  /**
   * Every shared-settings row. The table holds at most a few dozen rows (one per shared
   * preference), and both callers want all of them, so this is deliberately unpaginated.
   */
  async list(): Promise<readonly SettingRow[]> {
    return await this.driver.query<SettingRow>('SELECT * FROM settings ORDER BY id ASC;');
  }

  /**
   * Publish preferences to the shared noticeboard, in one transaction so a sync can never read a
   * half-published set.
   *
   * `updated_at` is deliberately not written: letting the table's trigger stamp it is what keeps the
   * timestamp honest — it is the moment the value actually changed on this device, which is what the
   * merge weighs against a peer's edit.
   *
   * Which is also why the upsert is **conditional**. The trigger stamps any UPDATE, so re-writing a
   * value that had not changed would move this row's timestamp past a peer's genuinely newer edit,
   * and the two devices would push the unchanged row back and forth indefinitely — the churn issue
   * #161 fixed on the merge side, reached from the write side instead. `planSettingPublishes`
   * already only offers real differences; the `WHERE` makes writing a no-op *impossible* rather than
   * merely unlikely, so a future caller cannot reintroduce it.
   */
  async publish(upserts: readonly SettingUpsert[]): Promise<void> {
    if (upserts.length === 0) return;
    this.assertWritable();
    await this.driver.transaction(
      upserts.map(({ storeKey, field, value }) => ({
        sql: `INSERT INTO settings (id, store_key, field, value) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET value = excluded.value
              WHERE settings.value <> excluded.value;`,
        params: [settingRowId(storeKey, field), storeKey, field, value],
      })),
    );
  }
}
