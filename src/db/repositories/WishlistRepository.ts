/**
 * WishlistRepository (feature-gap G8 — manual "to-buy" / wishlist).
 *
 * A standalone dictionary of **wanted-but-not-owned** things to buy — distinct from the
 * *stock-driven* reorder / shopping list (derived from items below their reorder point). Each
 * entry references no item, so this is an independent table like `contacts` / `projects`: a plain
 * synced LWW leaf carrying its own `updated_at`, with a random-UUID primary key.
 *
 * All the non-trivial logic (name/link/price validation, priority normalisation and the display
 * order) lives in the pure `@/features/purchasing/wishlist` seam; this repository is the thin SQL
 * glue around it. Creates/updates grow storage and are therefore Hard-Stop gated; deletes (which
 * free space) are not, and record a tombstone so the deletion propagates on the next sync (§7.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToWishlistEntry } from './mappers';
import { tombstoneStatement } from './tombstone';
import {
  WISHLIST_PRIORITIES,
  normaliseTargetPrice,
  normaliseWishlistName,
  normaliseWishlistNote,
  normaliseWishlistPriority,
  planWishlistEntry,
  sanitiseWishlistUrl,
  type WishlistPlanError,
} from '@/features/purchasing/wishlist';
import type {
  CreateWishlistInput,
  Page,
  PageParams,
  UpdateWishlistInput,
  WishlistEntry,
  WishlistRow,
} from './types';

/** User-facing message for each reason `planWishlistEntry` can reject an entry. */
const REJECTION_MESSAGE: Record<WishlistPlanError, string> = {
  EMPTY_NAME: 'A wishlist entry must have a name.',
  INVALID_URL: 'Enter a valid web link (http:// or https://), or leave it blank.',
  INVALID_PRICE: 'A target price must be a non-negative number.',
};

/**
 * The priority display order as a SQL `CASE` rank, built from the seam's `WISHLIST_PRIORITIES`
 * SSOT so the DB order can never drift from `sortWishlist`. The priority literals are `[A-Z]`
 * values from a compile-time const tuple (never user input), so interpolating them is safe.
 */
const PRIORITY_RANK_SQL = `CASE priority ${WISHLIST_PRIORITIES.map(
  (priority, index) => `WHEN '${priority}' THEN ${index}`,
).join(' ')} ELSE ${WISHLIST_PRIORITIES.length} END`;

export class WishlistRepository extends BaseRepository {
  async getById(id: string): Promise<WishlistEntry | undefined> {
    const row = await this.driver.queryOne<WishlistRow>('SELECT * FROM wishlist WHERE id = ?;', [id]);
    return row ? rowToWishlistEntry(row) : undefined;
  }

  /**
   * Paginated wishlist, ordered for display: by priority (High → None), then name
   * (case-insensitive), then oldest-first, then id — the exact total order the pure `sortWishlist`
   * seam produces, so a page is already correctly ordered.
   */
  async list(params: PageParams = {}): Promise<Page<WishlistEntry>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<WishlistRow>(
      `SELECT * FROM wishlist
       ORDER BY ${PRIORITY_RANK_SQL} ASC, name COLLATE NOCASE ASC, created_at ASC, id ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToWishlistEntry), limit, offset);
  }

  /**
   * Create a wishlist entry. The name/link/price are validated + normalised by the pure
   * `planWishlistEntry` seam (a blank name, a non-web link or a negative price is rejected with a
   * clear message); an unknown priority softens to `NONE`. Write-gated (it grows storage).
   */
  async create(input: CreateWishlistInput): Promise<WishlistEntry> {
    this.assertWritable();
    const plan = planWishlistEntry(input);
    if (!plan.ok) {
      throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE[plan.reason]);
    }
    const id = crypto.randomUUID();
    const { name, note, url, targetPrice, priority } = plan.entry;
    await this.driver.execute(
      `INSERT INTO wishlist (id, name, note, url, target_price, priority) VALUES (?, ?, ?, ?, ?, ?);`,
      [id, name, note, url, targetPrice, priority],
    );
    return (await this.getById(id))!;
  }

  /**
   * Update selected fields of a wishlist entry — only the provided fields change, and each is run
   * through the same seam normalisers `create` uses (so the same invariants hold): the name cannot
   * be cleared to blank, a supplied non-web link or negative price is rejected, an unknown priority
   * softens to `NONE`. Write-gated (an edit can grow storage). Returns the updated entry.
   */
  async update(id: string, input: UpdateWishlistInput): Promise<WishlistEntry> {
    this.assertWritable();
    await this.require(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.name !== undefined) {
      const name = normaliseWishlistName(input.name);
      if (name === null) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.EMPTY_NAME);
      sets.push('name = ?');
      params.push(name);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(normaliseWishlistNote(input.note));
    }
    if (input.url !== undefined) {
      const url = sanitiseWishlistUrl(input.url);
      if (url === undefined) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.INVALID_URL);
      sets.push('url = ?');
      params.push(url);
    }
    if (input.targetPrice !== undefined) {
      const targetPrice = normaliseTargetPrice(input.targetPrice);
      if (targetPrice === undefined) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.INVALID_PRICE);
      sets.push('target_price = ?');
      params.push(targetPrice);
    }
    if (input.priority !== undefined) {
      sets.push('priority = ?');
      params.push(normaliseWishlistPriority(input.priority));
    }

    if (sets.length > 0) {
      await this.driver.execute(`UPDATE wishlist SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a wishlist entry — DELETE + tombstone in the same transaction so the removal propagates
   * on the next sync (§7.2). Always permitted (a delete frees storage). A no-op when the id is
   * absent: no tombstone is recorded (tombstoning an id this device never held would wrongly
   * instruct peers to delete it).
   */
  async delete(id: string): Promise<void> {
    if (!(await this.getById(id))) return;
    await this.driver.transaction([
      { sql: 'DELETE FROM wishlist WHERE id = ?;', params: [id] },
      tombstoneStatement('wishlist', id),
    ]);
  }

  private async require(id: string): Promise<WishlistEntry> {
    const entry = await this.getById(id);
    if (!entry) {
      throw new DbError('SQLITE_CONSTRAINT', `Wishlist entry "${id}" does not exist.`);
    }
    return entry;
  }
}
