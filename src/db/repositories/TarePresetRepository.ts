/**
 * TarePresetRepository (issue #94 — reusable empty-container weights).
 *
 * The containers *this user* measured and saved, so a tare can be picked rather than retyped.
 * The app's built-in catalogue of common spools and containers is a pure code registry
 * (`@/features/inventory/tare-presets`) and never touches this table — see the schema comment
 * on `tare_presets` for why published reference figures must not be seeded into a user's data.
 *
 * An independent synced LWW leaf with a random-UUID primary key, like `wishlist`. All the
 * validation and normalisation lives in the pure seam; this is the thin SQL glue around it.
 * Creates/updates grow storage and are therefore Hard-Stop gated; deletes (which free space)
 * are not, and record a tombstone so the deletion propagates on the next sync (§7.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToSavedTarePreset } from './mappers';
import { tombstoneStatement } from './tombstone';
import {
  normaliseTareGrams,
  normaliseTarePresetKind,
  normaliseTarePresetName,
  normaliseTarePresetText,
  planTarePreset,
  type TarePresetPlanError,
} from '@/features/inventory/tare-presets';
import type {
  CreateTarePresetInput,
  Page,
  PageParams,
  SavedTarePreset,
  TarePresetRow,
  UpdateTarePresetInput,
} from './types';

/** User-facing message for each reason `planTarePreset` can reject an entry. */
const REJECTION_MESSAGE: Record<TarePresetPlanError, string> = {
  EMPTY_NAME: 'A saved container must have a name.',
  INVALID_TARE: 'An empty weight must be a non-negative number.',
};

export class TarePresetRepository extends BaseRepository {
  async getById(id: string): Promise<SavedTarePreset | undefined> {
    const row = await this.driver.queryOne<TarePresetRow>('SELECT * FROM tare_presets WHERE id = ?;', [id]);
    return row ? rowToSavedTarePreset(row) : undefined;
  }

  /**
   * Paginated saved containers, ordered for display: by name (case-insensitive), then
   * oldest-first, then id — a stable total order, so a page is already correctly ordered and
   * two containers sharing a name never swap places between reads.
   */
  async list(params: PageParams = {}): Promise<Page<SavedTarePreset>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<TarePresetRow>(
      `SELECT * FROM tare_presets
       ORDER BY name COLLATE NOCASE ASC, created_at ASC, id ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToSavedTarePreset), limit, offset);
  }

  /**
   * Save a container weight. The name/tare are validated + normalised by the pure
   * `planTarePreset` seam (a blank name or a negative/non-finite weight is rejected with a
   * clear message); an unknown kind softens to `OTHER`. Write-gated (it grows storage).
   */
  async create(input: CreateTarePresetInput): Promise<SavedTarePreset> {
    this.assertPermission('settings:write');
    this.assertWritable();
    const plan = planTarePreset(input);
    if (!plan.ok) {
      throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE[plan.reason]);
    }
    const id = crypto.randomUUID();
    const { name, brand, kind, tareGrams, note } = plan.preset;
    await this.driver.execute(
      `INSERT INTO tare_presets (id, name, brand, kind, tare_grams, note) VALUES (?, ?, ?, ?, ?, ?);`,
      [id, name, brand, kind, tareGrams, note],
    );
    return (await this.getById(id))!;
  }

  /**
   * Update selected fields of a saved container — only the provided fields change, and each is
   * run through the same seam normalisers `create` uses (so the same invariants hold): the name
   * cannot be cleared to blank, a negative or non-finite weight is rejected, an unknown kind
   * softens to `OTHER`. Write-gated (an edit can grow storage). Returns the updated entry.
   */
  async update(id: string, input: UpdateTarePresetInput): Promise<SavedTarePreset> {
    this.assertPermission('settings:write');
    this.assertWritable();
    await this.require(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.name !== undefined) {
      const name = normaliseTarePresetName(input.name);
      if (name === null) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.EMPTY_NAME);
      sets.push('name = ?');
      params.push(name);
    }
    if (input.brand !== undefined) {
      sets.push('brand = ?');
      params.push(normaliseTarePresetText(input.brand));
    }
    if (input.kind !== undefined) {
      sets.push('kind = ?');
      params.push(normaliseTarePresetKind(input.kind));
    }
    if (input.tareGrams !== undefined) {
      const tareGrams = normaliseTareGrams(input.tareGrams);
      if (tareGrams === undefined) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.INVALID_TARE);
      sets.push('tare_grams = ?');
      params.push(tareGrams);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(normaliseTarePresetText(input.note));
    }

    if (sets.length > 0) {
      await this.driver.execute(`UPDATE tare_presets SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a saved container — DELETE + tombstone in the same transaction so the removal
   * propagates on the next sync (§7.2). Always permitted (a delete frees storage). A no-op when
   * the id is absent: no tombstone is recorded (tombstoning an id this device never held would
   * wrongly instruct peers to delete it).
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('settings:write');
    if (!(await this.getById(id))) return;
    await this.driver.transaction([
      { sql: 'DELETE FROM tare_presets WHERE id = ?;', params: [id] },
      tombstoneStatement('tare_presets', id),
    ]);
  }

  private async require(id: string): Promise<SavedTarePreset> {
    const preset = await this.getById(id);
    if (!preset) {
      throw new DbError('SQLITE_CONSTRAINT', `Saved container "${id}" does not exist.`);
    }
    return preset;
  }
}
