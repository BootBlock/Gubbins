/**
 * Weighted-capabilities concern (spec §4 Weighted Capabilities, Phase 5). A raw value
 * is classified into a numeric magnitude (backing >/< comparisons) or a text value
 * (backing EQUALS/categorical matches); one value per (item, key).
 */
import { foldName } from '@/lib/name-fold';
import { DbError } from '../../errors';
import { DEFAULT_CAPABILITY_WEIGHT } from '../constants';
import { rowToCapability } from '../mappers';
import type {
  Capability,
  CapabilityKeySummary,
  CapabilityRow,
  Page,
  PageParams,
  SetCapabilityInput,
} from '../types';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withCapabilities<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemCapabilityRepository extends Base {
    /** An item's capabilities, ordered by key (case-insensitive). */
    async listCapabilities(itemId: string): Promise<Capability[]> {
      const rows = await this.driver.query<CapabilityRow>(
        'SELECT * FROM capabilities WHERE item_id = ? ORDER BY key COLLATE NOCASE ASC;',
        [itemId],
      );
      return rows.map(rowToCapability);
    }

    /**
     * Add or replace a capability keyed by (item, key). The raw value is classified
     * into a numeric magnitude (backing >/< comparisons) when it parses as a finite
     * number, otherwise a text value (backing EQUALS/categorical matches). One value
     * per key, so re-setting the same key overwrites it. Write-gated (it grows storage).
     */
    async setCapability(itemId: string, input: SetCapabilityInput): Promise<Capability> {
      this.assertPermission('items:write');
      this.assertWritable();
      await this.require(itemId);

      const key = input.key.trim();
      if (key.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A capability must have a key.');
      }
      const weight = input.weight ?? DEFAULT_CAPABILITY_WEIGHT;
      if (!Number.isFinite(weight) || weight < 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'Capability weight must be a non-negative number.');
      }

      const raw = input.value.trim();
      const num = Number(raw);
      const isNumeric = raw.length > 0 && Number.isFinite(num);
      const valueNum = isNumeric ? num : null;
      const valueText = isNumeric ? null : raw.length > 0 ? raw : null;

      const id = crypto.randomUUID();
      const superseded = await this.capabilityIdsForKey(itemId, key);
      await this.driver.transaction([
        // Replace any existing value for this key (case-insensitive) — one per (item,key).
        ...superseded.map((oldId) => ({
          sql: 'DELETE FROM capabilities WHERE id = ?;',
          params: [oldId],
        })),
        {
          sql: `INSERT INTO capabilities (id, item_id, key, value_num, value_text, weight)
                VALUES (?, ?, ?, ?, ?, ?);`,
          params: [id, itemId, key, valueNum, valueText, weight],
        },
      ]);
      const row = await this.driver.queryOne<CapabilityRow>('SELECT * FROM capabilities WHERE id = ?;', [id]);
      return rowToCapability(row!);
    }

    /**
     * The distinct capability *keys* carried across active inventory — the queryable
     * `cap:<key>` vocabulary (spec §4, §5.1) — paginated, busiest key first. For each key
     * it reports how many active items carry it and whether the stored values are numeric
     * (supporting `cap:key>n`) and/or textual (supporting `cap:key=value`). Read-only and
     * static parameterised SQL; one value per (item, key), so `itemCount` is also the row
     * count per key. Powers a "browse capabilities" view and the read-only query bridge.
     */
    async listCapabilityKeys(params: PageParams = {}): Promise<Page<CapabilityKeySummary>> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<{
        key: string;
        item_count: number;
        numeric_count: number;
        text_count: number;
      }>(
        `SELECT c.key AS key,
                COUNT(DISTINCT c.item_id) AS item_count,
                SUM(CASE WHEN c.value_num IS NOT NULL THEN 1 ELSE 0 END) AS numeric_count,
                SUM(CASE WHEN c.value_text IS NOT NULL THEN 1 ELSE 0 END) AS text_count
         FROM capabilities c
         JOIN items i ON i.id = c.item_id AND i.is_active = 1
         GROUP BY c.key COLLATE NOCASE
         ORDER BY item_count DESC, c.key COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [limit, offset],
      );
      return this.toPage(
        rows.map((r) => ({
          key: r.key,
          itemCount: Number(r.item_count),
          hasNumericValues: Number(r.numeric_count) > 0,
          hasTextValues: Number(r.text_count) > 0,
        })),
        limit,
        offset,
      );
    }

    /** Remove a capability by key (case-insensitive). Deletions bypass the Hard Stop. */
    async removeCapability(itemId: string, key: string): Promise<void> {
      this.assertPermission('items:write');
      const ids = await this.capabilityIdsForKey(itemId, key);
      if (ids.length === 0) return;
      await this.driver.transaction(
        ids.map((id) => ({ sql: 'DELETE FROM capabilities WHERE id = ?;', params: [id] })),
      );
    }

    /**
     * The ids of `itemId`'s capabilities whose key is `key` — the one seam both the replace and
     * the remove decide "same key?" through.
     *
     * **Decided in JS (issue #679).** `WHERE key = ? COLLATE NOCASE` folds ASCII A–Z only, so
     * re-setting `Größe` as `GRÖSSE` left the old row in place and the item ended up carrying two
     * values for one capability — which `UNIQUE (item_id, key COLLATE NOCASE)` permits but the
     * sync merge's natural-key resolver treats as a collision, retiring one of them mid-merge.
     * An item's capability set is small, so this reads it rather than narrowing as the
     * dictionary lookups in `name-lookup` do; ordered so the answer is stable on a database that
     * already holds both spellings.
     */
    private async capabilityIdsForKey(itemId: string, key: string): Promise<string[]> {
      const needle = foldName(key);
      if (needle.length === 0) return [];
      const rows = await this.driver.query<{ id: string; key: string }>(
        'SELECT id, key FROM capabilities WHERE item_id = ? ORDER BY key, id;',
        [itemId],
      );
      return rows.filter((r) => foldName(r.key) === needle).map((r) => r.id);
    }
  };
}
