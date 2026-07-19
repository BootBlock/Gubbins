/**
 * LocationPhotoRepository (issue #81).
 *
 * Owns location photos, the regions drawn onto them, and the M:N links from items to those
 * regions.
 *
 * Storage follows `ImageRepository` exactly: the **Anti-Base64 Directive (§4.2.1)** is
 * absolute, so full-resolution bytes never enter the database. The canvas→WebP→OPFS pipeline
 * in the UI layer writes the raw file and passes only its path here; on removal we hand the
 * path back so the caller can delete the orphaned file.
 *
 * The item link is a join table rather than an `item_id` column on the region because a
 * region is a *place* that exists independently of its contents. The layer beneath already
 * lets one item sit in several locations (`item_stock` is unique per item+location pair), so
 * a one-position-per-item model would contradict it.
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToLocationPhoto, rowToLocationRegion } from './mappers';
import {
  clearItemRegionTombstoneStatement,
  itemRegionTombstoneStatement,
  tombstoneStatement,
} from './tombstone';
import type {
  CreateLocationPhotoInput,
  CreateLocationRegionInput,
  ItemRegionPlacement,
  LocationPhoto,
  LocationPhotoRow,
  LocationRegion,
  LocationRegionRow,
  LocationRegionWithCount,
  UpdateLocationRegionInput,
} from './types';

export class LocationPhotoRepository extends BaseRepository {
  // --- Photos -------------------------------------------------------------------

  /** All photos for a location (bounded per location), in display order. */
  async listForLocation(locationId: string): Promise<LocationPhoto[]> {
    const rows = await this.driver.query<LocationPhotoRow>(
      `SELECT * FROM location_photos WHERE location_id = ?
       ORDER BY position ASC, created_at ASC;`,
      [locationId],
    );
    return rows.map(rowToLocationPhoto);
  }

  async getPhoto(id: string): Promise<LocationPhoto | undefined> {
    const row = await this.driver.queryOne<LocationPhotoRow>('SELECT * FROM location_photos WHERE id = ?;', [
      id,
    ]);
    return row ? rowToLocationPhoto(row) : undefined;
  }

  /** Insert one photo record. Write-gated (it grows storage). */
  async addPhoto(input: CreateLocationPhotoInput): Promise<LocationPhoto> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const path = input.fullResOpfsPath.trim();
    if (path.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location photo requires an OPFS path.');
    }
    // Zero or negative dimensions would make every normalised region undrawable, so reject
    // them here rather than storing a photo no region can ever be placed on.
    if (!(input.naturalWidth > 0) || !(input.naturalHeight > 0)) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location photo requires positive dimensions.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO location_photos
         (id, location_id, caption, thumbnail_blob, full_res_opfs_path, full_res_downgraded_at,
          natural_width, natural_height, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        input.locationId,
        input.caption ?? null,
        input.thumbnailBlob,
        path,
        input.fullResDowngradedAt ?? null,
        input.naturalWidth,
        input.naturalHeight,
        input.position ?? 0,
      ],
    );
    const row = await this.driver.queryOne<LocationPhotoRow>('SELECT * FROM location_photos WHERE id = ?;', [
      id,
    ]);
    return rowToLocationPhoto(row!);
  }

  /** Rename/re-caption a photo. */
  async updatePhotoCaption(id: string, caption: string | null): Promise<void> {
    this.assertPermission('locations:write');
    this.assertWritable();
    await this.driver.execute('UPDATE location_photos SET caption = ? WHERE id = ?;', [caption, id]);
  }

  /**
   * Delete a photo, returning its OPFS path so the caller can purge the raw file.
   * Permitted under the Hard Stop (it frees space).
   *
   * The row delete cascades to its regions and their item links, but **a cascade records no
   * tombstone of its own**, so the child regions are tombstoned explicitly in the same
   * transaction. Without that a peer would resurrect regions belonging to a photo that no
   * longer exists.
   */
  async removePhoto(id: string): Promise<string | undefined> {
    this.assertPermission('locations:write');
    const row = await this.driver.queryOne<{ full_res_opfs_path: string }>(
      'SELECT full_res_opfs_path FROM location_photos WHERE id = ?;',
      [id],
    );
    if (!row) return undefined;

    const regions = await this.driver.query<{ id: string }>(
      'SELECT id FROM location_regions WHERE photo_id = ?;',
      [id],
    );
    const links = await this.driver.query<{ item_id: string; region_id: string }>(
      `SELECT ir.item_id AS item_id, ir.region_id AS region_id
         FROM item_regions ir
         JOIN location_regions lr ON lr.id = ir.region_id
        WHERE lr.photo_id = ?;`,
      [id],
    );

    await this.driver.transaction([
      { sql: 'DELETE FROM location_photos WHERE id = ?;', params: [id] },
      tombstoneStatement('location_photos', id),
      ...regions.map((r) => tombstoneStatement('location_regions', r.id)),
      ...links.map((l) => itemRegionTombstoneStatement(l.item_id, l.region_id)),
    ]);
    return row.full_res_opfs_path;
  }

  // --- Regions ------------------------------------------------------------------

  /** Every region on a photo, in draw order, with its current item count. */
  async listRegions(photoId: string): Promise<LocationRegionWithCount[]> {
    const rows = await this.driver.query<LocationRegionRow & { item_count: number }>(
      `SELECT lr.*, COUNT(ir.item_id) AS item_count
         FROM location_regions lr
         LEFT JOIN item_regions ir ON ir.region_id = lr.id
        WHERE lr.photo_id = ?
        GROUP BY lr.id
        ORDER BY lr.position ASC, lr.created_at ASC;`,
      [photoId],
    );
    return rows.map((row) => ({ ...rowToLocationRegion(row), itemCount: row.item_count }));
  }

  async addRegion(input: CreateLocationRegionInput): Promise<LocationRegion> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A region requires a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO location_regions (id, photo_id, name, shape, geometry, color, position)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, input.photoId, name, input.shape, input.geometry, input.color ?? null, input.position ?? 0],
    );
    const row = await this.driver.queryOne<LocationRegionRow>(
      'SELECT * FROM location_regions WHERE id = ?;',
      [id],
    );
    return rowToLocationRegion(row!);
  }

  /**
   * Patch a region. The `shape` is deliberately immutable — a rectangle's geometry cannot be
   * reinterpreted as a polygon, so changing shape means deleting and redrawing.
   */
  async updateRegion(id: string, input: UpdateLocationRegionInput): Promise<void> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A region requires a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.geometry !== undefined) {
      sets.push('geometry = ?');
      params.push(input.geometry);
    }
    if (input.color !== undefined) {
      sets.push('color = ?');
      params.push(input.color);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.driver.execute(`UPDATE location_regions SET ${sets.join(', ')} WHERE id = ?;`, params);
  }

  /**
   * Delete a region. Items are only *unlinked* — deleting a place must never delete the
   * things that were in it. The cascade drops the links silently, so they are tombstoned
   * explicitly here for the same reason as {@link removePhoto}.
   */
  async removeRegion(id: string): Promise<void> {
    this.assertPermission('locations:write');
    const links = await this.driver.query<{ item_id: string }>(
      'SELECT item_id FROM item_regions WHERE region_id = ?;',
      [id],
    );
    await this.driver.transaction([
      { sql: 'DELETE FROM location_regions WHERE id = ?;', params: [id] },
      tombstoneStatement('location_regions', id),
      ...links.map((l) => itemRegionTombstoneStatement(l.item_id, id)),
    ]);
  }

  // --- Item links ---------------------------------------------------------------

  /** Items currently placed in a region, by id. */
  async listRegionItemIds(regionId: string): Promise<string[]> {
    const rows = await this.driver.query<{ item_id: string }>(
      'SELECT item_id FROM item_regions WHERE region_id = ?;',
      [regionId],
    );
    return rows.map((r) => r.item_id);
  }

  /**
   * Every region an item sits in, resolved up to its location — the item-side "where,
   * exactly?" panel.
   */
  async listPlacementsForItem(itemId: string): Promise<ItemRegionPlacement[]> {
    return this.driver.query<ItemRegionPlacement>(
      `SELECT lr.id      AS regionId,
              lr.name    AS regionName,
              lr.shape   AS shape,
              lr.geometry AS geometry,
              lr.color   AS color,
              lp.id      AS photoId,
              lp.location_id AS locationId,
              l.name     AS locationName
         FROM item_regions ir
         JOIN location_regions lr ON lr.id = ir.region_id
         JOIN location_photos  lp ON lp.id = lr.photo_id
         JOIN locations        l  ON l.id  = lp.location_id
        WHERE ir.item_id = ?
        ORDER BY l.name ASC, lr.position ASC;`,
      [itemId],
    );
  }

  /**
   * Place an item in a region. Idempotent (`INSERT OR IGNORE`), and it clears any stale edge
   * tombstone so re-linking after a delete survives the next membership reconcile rather
   * than being re-deleted by the peer's tombstone.
   */
  async linkItem(itemId: string, regionId: string): Promise<void> {
    this.assertPermission('locations:write');
    this.assertWritable();
    await this.driver.transaction([
      {
        sql: 'INSERT OR IGNORE INTO item_regions (item_id, region_id) VALUES (?, ?);',
        params: [itemId, regionId],
      },
      clearItemRegionTombstoneStatement(itemId, regionId),
    ]);
  }

  /** Remove an item from a region, tombstoning the edge so the deletion propagates. */
  async unlinkItem(itemId: string, regionId: string): Promise<void> {
    this.assertPermission('locations:write');
    await this.driver.transaction([
      {
        sql: 'DELETE FROM item_regions WHERE item_id = ? AND region_id = ?;',
        params: [itemId, regionId],
      },
      itemRegionTombstoneStatement(itemId, regionId),
    ]);
  }
}
