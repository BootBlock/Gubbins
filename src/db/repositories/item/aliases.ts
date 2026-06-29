/**
 * Universal Alias Mapping, external-scrape merge, and BOM auto-match concern
 * (spec §4, §9). Aliases participate in synchronisation (§7.1), so edits are diffed
 * (retained aliases keep their id; removals record a tombstone in the same
 * transaction) rather than wiped and reinserted.
 */
import type { SqlStatement, SqlValue } from '../../rpc/driver';
import { tombstoneStatement } from '../tombstone';
import { rowToItemAlias } from '../mappers';
import type { Item, ItemAlias, ItemAliasRow, ScrapeApplyInput } from '../types';
import { historyStatement } from './history';
import { normaliseText, normaliseUnitCost } from './normalise';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withAliases<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemAliasRepository extends Base {
    /** Supplier/alternative part identifiers mapped to this item, alphabetically. */
    async listAliases(itemId: string): Promise<ItemAlias[]> {
      const rows = await this.driver.query<ItemAliasRow>(
        'SELECT * FROM item_aliases WHERE item_id = ? ORDER BY alias COLLATE NOCASE ASC;',
        [itemId],
      );
      return rows.map(rowToItemAlias);
    }

    /**
     * Replace an item's alias set with the supplied list, de-duplicated
     * case-insensitively. Trimmed-empty entries are dropped. Each alias is unique
     * across the table, so reassigning one already owned by another item is rejected.
     * Write-gated (it grows storage).
     *
     * Now that `item_aliases` participates in synchronisation (§7.1, it carries its own
     * `updated_at`), this is a **diff** rather than a wipe-and-reinsert: retained
     * aliases keep their stable id (so LWW timestamps stay meaningful) and each removed
     * alias records a tombstone in the *same* transaction, so the deletion propagates on
     * the next sync instead of being resurrected from a peer (§7.2).
     */
    async setAliases(itemId: string, aliases: readonly string[]): Promise<ItemAlias[]> {
      this.assertWritable();
      await this.require(itemId);

      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of aliases) {
        const alias = raw.trim();
        if (alias.length === 0) continue;
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(alias);
      }

      const existing = await this.listAliases(itemId);
      const existingByKey = new Map(existing.map((a) => [a.alias.toLowerCase(), a]));
      const desiredKeys = new Set(cleaned.map((a) => a.toLowerCase()));

      const statements: SqlStatement[] = [];
      // Removals: existing aliases no longer wanted → DELETE + tombstone (atomically).
      for (const alias of existing) {
        if (!desiredKeys.has(alias.alias.toLowerCase())) {
          statements.push({ sql: 'DELETE FROM item_aliases WHERE id = ?;', params: [alias.id] });
          statements.push(tombstoneStatement('item_aliases', alias.id));
        }
      }
      // Additions: genuinely-new aliases → INSERT a fresh id (retained ones untouched).
      for (const alias of cleaned) {
        if (!existingByKey.has(alias.toLowerCase())) {
          statements.push({
            sql: 'INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);',
            params: [crypto.randomUUID(), itemId, alias],
          });
        }
      }

      if (statements.length > 0) await this.driver.transaction(statements);
      return this.listAliases(itemId);
    }

    /**
     * Atomically apply an external-scrape merge to an existing item (spec §4, §9).
     * Only the fields the caller decided to write are touched — the §4 no-overwrite
     * safeguard is enforced *before* this call by the pure merge engine — and the
     * supplier MPN(s) are mapped in as new aliases (§4 Universal Alias Mapping). The
     * field UPDATE, the alias INSERTs and the `SCRAPE_APPLIED` ledger entry all run in
     * one transaction, so the merge is all-or-nothing. Write-gated (it grows storage).
     * A no-op write returns the item unchanged without logging.
     */
    async applyScrape(id: string, write: ScrapeApplyInput): Promise<Item> {
      this.assertWritable();
      const existing = await this.require(id);

      const sets: string[] = [];
      const params: SqlValue[] = [];
      const changed: string[] = [];

      if (write.fields.mpn !== undefined) {
        sets.push('mpn = ?');
        params.push(normaliseText(write.fields.mpn));
        changed.push('MPN');
      }
      if (write.fields.manufacturer !== undefined) {
        sets.push('manufacturer = ?');
        params.push(normaliseText(write.fields.manufacturer));
        changed.push('manufacturer');
      }
      if (write.fields.unitCost !== undefined) {
        sets.push('unit_cost = ?');
        params.push(normaliseUnitCost(write.fields.unitCost));
        changed.push('unit cost');
      }
      if (write.fields.description !== undefined) {
        sets.push('description = ?');
        params.push(write.fields.description);
        changed.push('description');
      }

      const statements: SqlStatement[] = [];
      if (sets.length > 0) {
        statements.push({ sql: `UPDATE items SET ${sets.join(', ')} WHERE id = ?;`, params: [...params, id] });
      }
      for (const raw of write.aliasAdditions) {
        const alias = raw.trim();
        if (alias.length === 0) continue;
        statements.push({
          sql: 'INSERT INTO item_aliases (id, item_id, alias) VALUES (?, ?, ?);',
          params: [crypto.randomUUID(), id, alias],
        });
        changed.push(`alias "${alias}"`);
      }

      if (statements.length === 0) return existing;

      statements.push(
        historyStatement(id, 'SCRAPE_APPLIED', { note: `Applied scraped supplier data: ${changed.join(', ')}.` }),
      );
      await this.driver.transaction(statements);
      return (await this.getById(id))!;
    }

    /**
     * Resolve a BOM match key to a local item: first by exact (case-insensitive) MPN,
     * then by an alias mapping (§4). Returns undefined when nothing matches, so the
     * importer can leave the BOM line unmatched.
     */
    async findByMatchKey(key: string): Promise<Item | undefined> {
      const trimmed = key.trim();
      if (trimmed.length === 0) return undefined;

      const byMpn = await this.driver.queryOne<{ id: string }>(
        'SELECT id FROM items WHERE mpn = ? COLLATE NOCASE LIMIT 1;',
        [trimmed],
      );
      if (byMpn) return this.getById(byMpn.id);

      const byAlias = await this.driver.queryOne<{ item_id: string }>(
        'SELECT item_id FROM item_aliases WHERE alias = ? COLLATE NOCASE LIMIT 1;',
        [trimmed],
      );
      return byAlias ? this.getById(byAlias.item_id) : undefined;
    }
  };
}
