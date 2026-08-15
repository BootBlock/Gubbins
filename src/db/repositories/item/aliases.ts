/**
 * Universal Alias Mapping, external-scrape merge, and BOM auto-match concern
 * (spec §4, §9). Aliases participate in synchronisation (§7.1), so edits are diffed
 * (retained aliases keep their id; removals record a tombstone in the same
 * transaction) rather than wiped and reinserted.
 */
import { foldName } from '@/lib/name-fold';
import type { SqlStatement, SqlValue } from '../../rpc/driver';
import { duplicateNameError, foldedNameFilter, matchesFoldedName } from '../name-lookup';
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
     *
     * **"Case-insensitively" means `lib/name-fold`'s fold, and the search is table-wide**
     * (issue #679). `toLowerCase()` leaves `ß` and `İ` alone and `idx_item_aliases_alias` folds
     * ASCII A–Z, so both of the old comparisons let `Größe` and `GRÖSSE` be filed as two
     * aliases — legal to the index, but one alias to the sync merge's natural-key resolver,
     * which then plans a merge the index rejects. The table-wide read is what makes the
     * cross-item half of that reachable too: the index cannot refuse `CAFÉ` on a second item
     * when a first already holds `Café`, so the refusal is raised here instead, in the same
     * words SQLite uses for the spellings it *can* fold.
     */
    async setAliases(itemId: string, aliases: readonly string[]): Promise<ItemAlias[]> {
      this.assertPermission('items:write');
      this.assertWritable();
      await this.require(itemId);

      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of aliases) {
        const alias = raw.trim();
        if (alias.length === 0) continue;
        const key = foldName(alias);
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(alias);
      }

      // Every row in the table that folds onto a requested alias — this item's (which are
      // retained) and any other item's (which make the request impossible to honour).
      const filter = foldedNameFilter('alias', cleaned);
      const claimed = (
        await this.driver.query<ItemAliasRow>(
          `SELECT * FROM item_aliases WHERE ${filter.sql} ORDER BY alias, id;`,
          filter.params,
        )
      ).filter((row) => matchesFoldedName(filter, row.alias));
      if (claimed.some((row) => row.item_id !== itemId)) {
        throw duplicateNameError('item_aliases.alias');
      }

      const existing = await this.listAliases(itemId);
      const existingByKey = new Map(existing.map((a) => [foldName(a.alias), a]));
      const desiredKeys = new Set(cleaned.map(foldName));

      const statements: SqlStatement[] = [];
      // Removals: existing aliases no longer wanted → DELETE + tombstone (atomically).
      for (const alias of existing) {
        if (!desiredKeys.has(foldName(alias.alias))) {
          statements.push({ sql: 'DELETE FROM item_aliases WHERE id = ?;', params: [alias.id] });
          statements.push(tombstoneStatement('item_aliases', alias.id));
        }
      }
      // Additions: genuinely-new aliases → INSERT a fresh id (retained ones untouched).
      for (const alias of cleaned) {
        if (!existingByKey.has(foldName(alias))) {
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
      this.assertPermission('items:write');
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
        statements.push({
          sql: `UPDATE items SET ${sets.join(', ')} WHERE id = ?;`,
          params: [...params, id],
        });
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
        historyStatement(id, 'SCRAPE_APPLIED', this.actorId(), {
          note: `Applied scraped supplier data: ${changed.join(', ')}.`,
        }),
      );
      await this.driver.transaction(statements);
      return (await this.getById(id))!;
    }

    /**
     * Resolve a BOM match key to a local item: first by exact (case-insensitive) MPN,
     * then by an alias mapping (§4). Returns undefined when nothing matches, so the
     * importer can leave the BOM line unmatched.
     *
     * The alias half matches through `lib/name-fold`, so an import finds the row `setAliases`
     * would have refused to duplicate — the two halves of one identity question agreeing
     * (issue #679). `mpn` keeps the collation: it carries no uniqueness constraint for a fold
     * to disagree with, and it is a manufacturer's part number rather than a typed name.
     */
    async findByMatchKey(key: string): Promise<Item | undefined> {
      const trimmed = key.trim();
      if (trimmed.length === 0) return undefined;

      const byMpn = await this.driver.queryOne<{ id: string }>(
        'SELECT id FROM items WHERE mpn = ? COLLATE NOCASE LIMIT 1;',
        [trimmed],
      );
      if (byMpn) return this.getById(byMpn.id);

      const filter = foldedNameFilter('alias', [trimmed]);
      const byAlias = (
        await this.driver.query<{ item_id: string; alias: string }>(
          `SELECT item_id, alias FROM item_aliases WHERE ${filter.sql} ORDER BY alias, id;`,
          filter.params,
        )
      ).find((row) => matchesFoldedName(filter, row.alias));
      return byAlias ? this.getById(byAlias.item_id) : undefined;
    }
  };
}
