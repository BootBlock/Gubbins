/**
 * TagRepository (spec §2.1.1, §4, §5 freeform tagging; locations added by issue #84).
 *
 * A freeform tag dictionary (`tags`) plus its item join (`item_tags`) and location join
 * (`location_tags`). The same dictionary is shared across both, so `fragile` on an item and
 * `fragile` on a location are the *same* tag. Tagging is deliberately low-friction (§4
 * ergonomics): assigning a brand-new tag name auto-creates the tag, reusing any existing tag
 * case-insensitively rather than duplicating it — through the app's Unicode fold, so that reuse
 * holds for `Ölkanne` as firmly as for `Fragile` (see {@link TagRepository.matchTagsByName} and
 * `lib/name-fold`). The `setFor*` diffs the requested set against the current one so only
 * genuine additions are gated by the storage Hard Stop; dropping a tag (which frees space) is
 * always permitted. The management surface (`create`/`rename`/`remove`/`merge`) edits the
 * dictionary itself.
 */
import { foldName } from '@/lib/name-fold';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { assertTextLimit } from './text-limits';
import type { SqlStatement } from '../rpc/driver';
import { BaseRepository } from './base';
import { escapeLike } from './like';
import { rowToTag } from './mappers';
import { foldedNameFilter, matchesFoldedName } from './name-lookup';
import {
  clearItemTagTombstoneStatement,
  clearLocationTagTombstoneStatement,
  itemTagTombstoneStatement,
  locationTagTombstoneStatement,
  tombstoneStatement,
} from './tombstone';
import type { Page, PageParams, Tag, TagFilter, TagListParams, TagRow, TagSort, TagWithCount } from './types';

interface TagCountRow extends TagRow {
  readonly item_count: number;
  readonly location_count: number;
}

/**
 * The `WHERE` clause (and its bound parameter) for a {@link TagFilter} — written once so
 * {@link TagRepository.list} and {@link TagRepository.count} can never disagree about what
 * matches, which would size the page strip for a different result set than the rows.
 *
 * `LIKE` is case-insensitive for ASCII in SQLite, which is what a name filter wants, and the
 * term is escaped so a typed `%` or `_` matches itself rather than acting as a wildcard.
 */
function tagFilter(filter: TagFilter): { where: string; params: string[] } {
  const term = filter.search?.trim() ?? '';
  if (term.length === 0) return { where: '', params: [] };
  return { where: `WHERE t.name LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(term)}%`] };
}

/**
 * The `ORDER BY` for each {@link TagSort}, allow-listed rather than composed from the caller's
 * string — the ordering is the one part of the query a filter can't parameterise, so it is
 * chosen from a fixed table and never interpolated from input.
 *
 * The usage orders sort on the two counts *summed*: "used" means carried by anything, so a tag on
 * five locations and no items is as used as one on five items. Every entry ends in `t.id ASC`,
 * which makes the ordering total — without it, OFFSET paging over the many tags that share a
 * usage count could repeat one row on page 2 while dropping another entirely (issue #149).
 */
const TAG_ORDER_BY: Record<TagSort, string> = {
  NAME_ASC: 't.name COLLATE NOCASE ASC, t.id ASC',
  NAME_DESC: 't.name COLLATE NOCASE DESC, t.id ASC',
  USAGE_DESC: '(item_count + location_count) DESC, t.name COLLATE NOCASE ASC, t.id ASC',
  USAGE_ASC: '(item_count + location_count) ASC, t.name COLLATE NOCASE ASC, t.id ASC',
};

export class TagRepository extends BaseRepository {
  /**
   * Paginated tag dictionary with live item + location counts, ordered by name by default.
   *
   * `search` and `sort` are resolved **here** rather than by the caller filtering a page it has
   * already read (issue #137): a filter applied to one page of a paged dictionary can only narrow
   * that page, leaving every tag past it exactly as unreachable as before — on the one screen
   * whose job is to manage all of them. Pair with {@link count}, given the same filter.
   */
  async list(params: TagListParams = {}): Promise<Page<TagWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const { where, params: filterParams } = tagFilter(params);
    const orderBy = TAG_ORDER_BY[params.sort ?? 'NAME_ASC'] ?? TAG_ORDER_BY.NAME_ASC;
    const rows = await this.driver.query<TagCountRow>(
      `SELECT t.id, t.name, t.updated_at,
              (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS item_count,
              (SELECT COUNT(*) FROM location_tags lt WHERE lt.tag_id = t.id) AS location_count
       FROM tags t
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?;`,
      [...filterParams, limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({
        ...rowToTag(r),
        itemCount: Number(r.item_count),
        locationCount: Number(r.location_count),
      })),
      limit,
      offset,
    );
  }

  /**
   * How many tags match the same filter {@link list} would apply — the denominator behind the
   * Tags screen's pagination (issue #84), and behind "how many did that filter leave" (#137). A
   * dictionary can outgrow one page, and that screen is where the whole set is managed, so it
   * pages server-side rather than slicing a single capped read (which would silently hide every
   * tag past the first page).
   */
  async count(filter: TagFilter = {}): Promise<number> {
    const { where, params } = tagFilter(filter);
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tags t ${where};`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  /**
   * The tag dictionary *without* usage counts, ordered by name — the tag-entry combobox
   * (issue #84). Deliberately not {@link list}: that annotates every row with two correlated
   * COUNT subqueries over `item_tags` / `location_tags`, which the picker never reads. Those
   * counts only earn their cost on the management screen.
   */
  async listNames(params: PageParams = {}): Promise<Page<Tag>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<TagRow>(
      `SELECT * FROM tags ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToTag), limit, offset);
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

  /**
   * The tags for a *set* of items in one round-trip — the item-card Tags field (issue #84).
   * Returns flat `{ itemId, name }` rows ordered by item then tag name; the caller groups them
   * into a per-item map. An empty input short-circuits to no query.
   */
  async listForItems(itemIds: readonly string[]): Promise<{ itemId: string; name: string }[]> {
    if (itemIds.length === 0) return [];
    const placeholders = itemIds.map(() => '?').join(', ');
    const rows = await this.driver.query<{ item_id: string; name: string }>(
      `SELECT it.item_id, t.name FROM item_tags it
       JOIN tags t ON t.id = it.tag_id
       WHERE it.item_id IN (${placeholders})
       ORDER BY it.item_id, t.name COLLATE NOCASE ASC;`,
      [...itemIds],
    );
    return rows.map((r) => ({ itemId: r.item_id, name: r.name }));
  }

  /** The tags currently assigned to a location (bounded set), ordered by name (issue #84). */
  async getForLocation(locationId: string): Promise<Tag[]> {
    const rows = await this.driver.query<TagRow>(
      `SELECT t.* FROM tags t
       JOIN location_tags lt ON lt.tag_id = t.id
       WHERE lt.location_id = ?
       ORDER BY t.name COLLATE NOCASE ASC;`,
      [locationId],
    );
    return rows.map(rowToTag);
  }

  /**
   * Every `location_tags` edge with its tag name (issue #84 — the sidebar tag filter). Locations
   * are a bounded set, so this reads the whole join in one query; the caller indexes it by
   * location and by tag.
   */
  async listLocationTagEdges(): Promise<{ locationId: string; tagId: string; tagName: string }[]> {
    const rows = await this.driver.query<{ location_id: string; tag_id: string; name: string }>(
      `SELECT lt.location_id, lt.tag_id, t.name FROM location_tags lt
       JOIN tags t ON t.id = lt.tag_id
       ORDER BY t.name COLLATE NOCASE ASC;`,
    );
    return rows.map((r) => ({ locationId: r.location_id, tagId: r.tag_id, tagName: r.name }));
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
    this.assertPermission('items:write');
    await this.applyTagSet(ITEM_BINDING, itemId, names);
  }

  /**
   * Replace a location's tag set with `names` (issue #84 — the location counterpart of
   * {@link setForItem}, sharing the same dictionary and low-friction auto-create).
   */
  async setForLocation(locationId: string, names: readonly string[]): Promise<void> {
    this.assertPermission('locations:write');
    await this.applyTagSet(LOCATION_BINDING, locationId, names);
  }

  // --- dictionary management (issue #84) -----------------------------------------

  /**
   * Create a tag by name, reusing an existing one case-insensitively. Returns the
   * resolved tag. A growth-write, so gated by the storage Hard Stop.
   */
  async create(name: string): Promise<Tag> {
    this.assertPermission('tags:write');
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('A tag name cannot be empty.');
    assertTextLimit(trimmed, TEXT_LIMITS.line, 'A tag name');
    const [existing] = await this.matchTagsByName([trimmed]);
    if (existing) return existing;
    this.assertWritable();
    const id = crypto.randomUUID();
    await this.driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', [id, trimmed]);
    return rowToTag({ id, name: trimmed, updated_at: 0 });
  }

  /**
   * Rename a tag. Throws {@link TagNameInUseError} (carrying the clashing tag's id, so the
   * caller can offer a merge) if another tag already uses the name case-insensitively. Not a
   * growth-write, so not Hard-Stop gated.
   *
   * The clash is looked up through {@link matchTagsByName} rather than its own `WHERE`, so
   * renaming to a name that already exists and *assigning* that name reach the same verdict —
   * a rename that the tag editor would have folded into an existing tag must not slip past as
   * a second one (issue #342).
   */
  async rename(id: string, name: string): Promise<void> {
    this.assertPermission('tags:write');
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('A tag name cannot be empty.');
    assertTextLimit(trimmed, TEXT_LIMITS.line, 'A tag name');
    const clash = (await this.matchTagsByName([trimmed])).find((t) => t.id !== id);
    if (clash) throw new TagNameInUseError(clash.id, trimmed);
    await this.driver.execute('UPDATE tags SET name = ? WHERE id = ?;', [trimmed, id]);
  }

  /**
   * Delete a tag from the dictionary and record its tombstone. Its `item_tags` /
   * `location_tags` edges are cascade-removed locally by the FK; on the next sync the tag
   * tombstone deletes it (and cascades its edges) on every peer. Frees space, so not gated.
   */
  async remove(id: string): Promise<void> {
    this.assertPermission('tags:delete');
    await this.driver.transaction([
      { sql: 'DELETE FROM tags WHERE id = ?;', params: [id] },
      tombstoneStatement('tags', id),
    ]);
  }

  /**
   * Merge `sourceId` into `targetId`: re-point every item and location that carries the
   * source tag onto the target (deduplicated), then delete the now-orphaned source tag. The
   * re-pointed edges are genuine membership additions (they propagate on sync), and the
   * source tag's tombstone cascades its old edges away everywhere. A growth-write, so gated.
   */
  async merge(sourceId: string, targetId: string): Promise<void> {
    this.assertPermission('tags:write');
    if (sourceId === targetId) return;
    this.assertWritable();
    const statements: SqlStatement[] = [];

    const itemRows = await this.driver.query<{ item_id: string }>(
      'SELECT item_id FROM item_tags WHERE tag_id = ?;',
      [sourceId],
    );
    for (const { item_id } of itemRows) {
      statements.push({
        sql: 'INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?);',
        params: [item_id, targetId],
      });
      statements.push(clearItemTagTombstoneStatement(item_id, targetId));
    }

    const locationRows = await this.driver.query<{ location_id: string }>(
      'SELECT location_id FROM location_tags WHERE tag_id = ?;',
      [sourceId],
    );
    for (const { location_id } of locationRows) {
      statements.push({
        sql: 'INSERT OR IGNORE INTO location_tags (location_id, tag_id) VALUES (?, ?);',
        params: [location_id, targetId],
      });
      statements.push(clearLocationTagTombstoneStatement(location_id, targetId));
    }

    statements.push({ sql: 'DELETE FROM tags WHERE id = ?;', params: [sourceId] });
    statements.push(tombstoneStatement('tags', sourceId));
    await this.driver.transaction(statements);
  }

  // --- internals -----------------------------------------------------------------

  /**
   * Shared diff-and-apply for {@link setForItem} / {@link setForLocation}. Normalises the
   * requested names, resolves/creates tag ids, then adds only genuine additions (Hard-Stop
   * gated) and removes dropped ones (recording an edge tombstone each). Runs atomically.
   */
  private async applyTagSet(
    binding: TagOwnerBinding,
    ownerId: string,
    names: readonly string[],
  ): Promise<void> {
    // Normalise: trim, drop blanks, dedupe case-insensitively (keep first casing). The fold is
    // `lib/name-fold`'s, the same one the stored rows are matched through below — dedupe the
    // request more loosely than the dictionary is searched and one save collapses two spellings
    // that a second save would file as two tags (issue #342).
    const desired: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = raw.trim();
      if (name.length === 0) continue;
      const key = foldName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      desired.push(name);
    }

    const existingTags = await this.matchTagsByName(desired);
    // First match wins, over `matchTagsByName`'s stable order: a database written before this
    // fold existed can already hold both `Ölkanne` and `ölkanne`, and which one a tag joins
    // must not depend on the order the rows came back in.
    const existingByKey = new Map<string, Tag>();
    for (const tag of existingTags) {
      const key = foldName(tag.name);
      if (!existingByKey.has(key)) existingByKey.set(key, tag);
    }
    const current = await binding.getCurrent(this, ownerId);
    const currentIds = new Set(current.map((t) => t.id));

    // Resolve a tag id for every desired name, planning creation for new ones.
    const createStatements: SqlStatement[] = [];
    const desiredIds = new Set<string>();
    for (const name of desired) {
      const existing = existingByKey.get(foldName(name));
      if (existing) {
        desiredIds.add(existing.id);
      } else {
        const id = crypto.randomUUID();
        desiredIds.add(id);
        existingByKey.set(foldName(name), { ...rowToTag({ id, name, updated_at: 0 }) });
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
        sql: `INSERT OR IGNORE INTO ${binding.table} (${binding.ownerCol}, tag_id) VALUES (?, ?);`,
        params: [ownerId, tagId],
      });
      // Clear any stale edge tombstone so a re-link is genuinely present again (membership:
      // the join has no updated_at, so deletions are tracked as edge tombstones keyed by
      // owner|tag; a fresh link must drop the tombstone).
      statements.push(binding.clearTombstone(ownerId, tagId));
    }
    for (const tagId of toRemove) {
      statements.push({
        sql: `DELETE FROM ${binding.table} WHERE ${binding.ownerCol} = ? AND tag_id = ?;`,
        params: [ownerId, tagId],
      });
      // Record the unlink as an edge tombstone so it propagates on the next sync.
      statements.push(binding.tombstone(ownerId, tagId));
    }
    await this.driver.transaction(statements);
  }

  /**
   * The existing tags whose names match any of `names` case-insensitively — the one seam every
   * "is this tag already in the dictionary?" question goes through.
   *
   * **Decided in JS; the SQL only narrows the candidates (issue #342).** `WHERE LOWER(name) IN
   * (…)` bound to JS-lowercased parameters reads like one comparison but is two different ones:
   * SQLite's `LOWER()` folds ASCII A–Z and nothing else, so a stored `Ölkanne` stays `Ölkanne`
   * while the parameter is `ölkanne`, the two never meet, and the dictionary grows a second,
   * visually identical tag. `idx_tags_name … COLLATE NOCASE` folds ASCII only for the same
   * reason, so it does not catch the duplicate either. The verdict therefore comes from
   * `lib/name-fold` — the same fold the field dictionary (issue #343) and the sync merge's
   * natural-key resolution already reach for, so all three agree on what one name means.
   *
   * The narrowing that makes the `WHERE` a deliberate **superset** of the answer is
   * `name-lookup`'s, shared with every other folded natural key (issue #679) — see that module
   * for why it takes the shape it does, and what it costs. Ordered so the answer is stable: a
   * database written before this fold existed can already hold both spellings, and callers take
   * the first match.
   */
  private async matchTagsByName(names: readonly string[]): Promise<Tag[]> {
    if (names.length === 0) return [];
    const filter = foldedNameFilter('name', names);
    const rows = await this.driver.query<TagRow>(
      `SELECT * FROM tags WHERE ${filter.sql} ORDER BY name, id;`,
      filter.params,
    );
    return rows.map(rowToTag).filter((tag) => matchesFoldedName(filter, tag.name));
  }
}

/**
 * Thrown by {@link TagRepository.rename} when the requested name already belongs to a
 * *different* tag. Carries that tag's id so the caller can offer to merge into it.
 */
export class TagNameInUseError extends Error {
  // A field declaration + explicit assignment, never a constructor parameter property: this
  // module is reachable from the bridge, which Node loads with its strip-only TypeScript loader
  // — that erases types without emitting the assignment a parameter property implies, so one
  // here fails the whole bridge at import time. Guarded by `npm run smoke:bridge`.
  readonly existingTagId: string;
  constructor(existingTagId: string, name: string) {
    super(`A tag named “${name}” already exists.`);
    this.existingTagId = existingTagId;
    this.name = 'TagNameInUseError';
  }
}

/** Binds the shared {@link TagRepository.applyTagSet} to one owner's join table. */
interface TagOwnerBinding {
  readonly table: string;
  readonly ownerCol: string;
  getCurrent(repo: TagRepository, ownerId: string): Promise<Tag[]>;
  tombstone(ownerId: string, tagId: string): SqlStatement;
  clearTombstone(ownerId: string, tagId: string): SqlStatement;
}

const ITEM_BINDING: TagOwnerBinding = {
  table: 'item_tags',
  ownerCol: 'item_id',
  getCurrent: (repo, ownerId) => repo.getForItem(ownerId),
  tombstone: itemTagTombstoneStatement,
  clearTombstone: clearItemTagTombstoneStatement,
};

const LOCATION_BINDING: TagOwnerBinding = {
  table: 'location_tags',
  ownerCol: 'location_id',
  getCurrent: (repo, ownerId) => repo.getForLocation(ownerId),
  tombstone: locationTagTombstoneStatement,
  clearTombstone: clearLocationTagTombstoneStatement,
};
