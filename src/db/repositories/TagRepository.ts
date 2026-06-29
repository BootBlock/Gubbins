/**
 * TagRepository (spec §2.1.1, §4, §5 freeform tagging).
 *
 * A freeform tag dictionary (`tags`) plus its item join (`item_tags`). Tagging is
 * deliberately low-friction (§4 ergonomics): assigning a brand-new tag name to an
 * item auto-creates the tag, reusing any existing tag case-insensitively rather
 * than duplicating it. `setForItem` diffs the requested set against the current one
 * so only genuine additions are gated by the storage Hard Stop; dropping a tag
 * (which frees space) is always permitted.
 */
import type { SqlStatement } from '../rpc/driver';
import { BaseRepository } from './base';
import { rowToTag } from './mappers';
import { clearItemTagTombstoneStatement, itemTagTombstoneStatement } from './tombstone';
import type { Page, PageParams, Tag, TagRow, TagWithCount } from './types';

interface TagCountRow extends TagRow {
  readonly item_count: number;
}

export class TagRepository extends BaseRepository {
  /** Paginated tag dictionary with live item counts, ordered by name. */
  async list(params: PageParams = {}): Promise<Page<TagWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<TagCountRow>(
      `SELECT t.id, t.name, t.updated_at, COUNT(it.item_id) AS item_count
       FROM tags t
       LEFT JOIN item_tags it ON it.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToTag(r), itemCount: Number(r.item_count) })),
      limit,
      offset,
    );
  }

  /** The tags currently assigned to an item (bounded set), ordered by name. */
  async getForItem(itemId: string): Promise<Tag[]> {
    const rows = await this.driver.query<TagRow>(
      `SELECT t.* FROM tags t
       JOIN item_tags it ON it.tag_id = t.id
       WHERE it.item_id = ?
       ORDER BY t.name COLLATE NOCASE ASC;`,
      [itemId],
    );
    return rows.map(rowToTag);
  }

  /** Prefix autocomplete over the tag dictionary. */
  async suggest(prefix: string, limit = 20): Promise<Tag[]> {
    const term = prefix.trim();
    if (term.length === 0) return [];
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = await this.driver.query<TagRow>(
      `SELECT * FROM tags WHERE name LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE ASC LIMIT ?;`,
      [`${escapeLike(term)}%`, capped],
    );
    return rows.map(rowToTag);
  }

  /**
   * Replace an item's tag set with `names`, auto-creating unknown tags and reusing
   * existing ones case-insensitively. Input is trimmed and de-duplicated; only the
   * resulting additions are Hard-Stop gated. Runs atomically.
   */
  async setForItem(itemId: string, names: readonly string[]): Promise<void> {
    // Normalise: trim, drop blanks, dedupe case-insensitively (keep first casing).
    const desired: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = raw.trim();
      if (name.length === 0) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      desired.push(name);
    }

    const existingTags = await this.matchTagsByName(desired);
    const existingByKey = new Map(existingTags.map((t) => [t.name.toLowerCase(), t]));
    const current = await this.getForItem(itemId);
    const currentIds = new Set(current.map((t) => t.id));

    // Resolve a tag id for every desired name, planning creation for new ones.
    const createStatements: SqlStatement[] = [];
    const desiredIds = new Set<string>();
    for (const name of desired) {
      const existing = existingByKey.get(name.toLowerCase());
      if (existing) {
        desiredIds.add(existing.id);
      } else {
        const id = crypto.randomUUID();
        desiredIds.add(id);
        existingByKey.set(name.toLowerCase(), { ...rowToTag({ id, name, updated_at: 0 }) });
        createStatements.push({
          sql: 'INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?);',
          params: [id, name],
        });
      }
    }

    const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

    if (createStatements.length > 0 || toAdd.length > 0) {
      this.assertWritable();
    }
    if (createStatements.length === 0 && toAdd.length === 0 && toRemove.length === 0) {
      return;
    }

    const statements: SqlStatement[] = [...createStatements];
    for (const tagId of toAdd) {
      statements.push({
        sql: 'INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?);',
        params: [itemId, tagId],
      });
      // Clear any stale edge tombstone so a re-link is genuinely present again (Phase 11
      // membership: item_tags has no updated_at, so deletions are tracked as edge
      // tombstones keyed by item_id|tag_id; a fresh link must drop the tombstone).
      statements.push(clearItemTagTombstoneStatement(itemId, tagId));
    }
    for (const tagId of toRemove) {
      statements.push({
        sql: 'DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?;',
        params: [itemId, tagId],
      });
      // Record the unlink as an edge tombstone so it propagates on the next sync.
      statements.push(itemTagTombstoneStatement(itemId, tagId));
    }
    await this.driver.transaction(statements);
  }

  // --- internals -----------------------------------------------------------------

  /** Fetch existing tag rows matching any of the given names (case-insensitively). */
  private async matchTagsByName(names: readonly string[]): Promise<Tag[]> {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(', ');
    const rows = await this.driver.query<TagRow>(
      `SELECT * FROM tags WHERE LOWER(name) IN (${placeholders});`,
      names.map((n) => n.toLowerCase()),
    );
    return rows.map(rowToTag);
  }
}

/** Escape LIKE wildcards so user input is matched literally (ESCAPE '\\'). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
