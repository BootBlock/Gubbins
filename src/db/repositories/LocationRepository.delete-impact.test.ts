/**
 * Parity between what {@link LocationRepository.getDeleteImpact} *claims* a delete will do and what
 * {@link LocationRepository.delete} actually does (issue #823).
 *
 * The impact read is a promise made to the user at the one moment they cannot take it back, and
 * `LocationDeleteImpact` enumerates in prose what "cannot come back". Prose cannot hold that
 * together with the SQL that destroys the rows, so every test here drives *both* sides: it counts
 * the rows, reads the impact, runs the real delete against the real schema, and counts again.
 * Narrow one of the impact's sub-selects and the before/after arithmetic disagrees.
 *
 * The list of tables compared is **read out of the schema**, not written down here (see
 * {@link directCascadeTables}). That is what makes the claim more than "the numbers match": add a
 * table with an `ON DELETE CASCADE` foreign key to `locations` and it appears in that set, so
 * `names every table that cascades directly off a location` fails until the impact names it too.
 * The reach of that is honest rather than total — SQLite reports only *direct* references, so the
 * two tables that cascade through a chain (`location_regions` via `location_photos`, `item_regions`
 * via `location_regions`) are still counted by hand in {@link chainedRowCounts}.
 *
 * The scenario is the one from the issue: a Garage that homes nothing the sidebar can see, but that
 * carries a whole photographed, region-mapped, tagged branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { LocationRepository } from './LocationRepository';
import type { LocationDeleteImpact } from './types';
import { LocationPhotoRepository } from './LocationPhotoRepository';
import { ItemRepository } from './ItemRepository';
import { CategoryRepository } from './CategoryRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { TagRepository } from './TagRepository';
import { UNASSIGNED_LOCATION_ID } from './constants';

describe('LocationRepository.getDeleteImpact', () => {
  let driver: MemoryDriver;
  let locations: LocationRepository;
  let photos: LocationPhotoRepository;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let checkouts: CheckoutRepository;
  let tags: TagRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    locations = new LocationRepository(driver);
    photos = new LocationPhotoRepository(driver);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    checkouts = new CheckoutRepository(driver);
    tags = new TagRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /**
   * Which {@link LocationDeleteImpact} field counts each table that cascades *directly* off a
   * location. The keys are checked against the schema below, so this map cannot quietly fall
   * behind a new cascading table — the test fails naming the table nothing counts.
   */
  const CASCADE_FIELD = {
    location_photos: 'photos',
    location_tags: 'tags',
    location_field_values: 'fieldValues',
    checkouts: 'loanRecords',
  } as const satisfies Record<string, keyof LocationDeleteImpact>;

  /**
   * Every table SQLite says holds an `ON DELETE CASCADE` foreign key to `locations`, read from the
   * live schema. `checkouts` appears once, for its borrower `location_id`: the `source_location_id`
   * reference on the same table is a plain (non-cascading) one and is correctly left out.
   */
  async function directCascadeTables(): Promise<{ table: string; column: string }[]> {
    const rows = await driver.query<{ table_name: string; column_name: string }>(
      `SELECT m.name AS table_name, fk."from" AS column_name
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) fk
        WHERE m.type = 'table' AND fk."table" = 'locations' AND fk.on_delete = 'CASCADE'
        ORDER BY m.name;`,
    );
    return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
  }

  /** How many rows each directly-cascading table holds for one location. */
  async function directRowCounts(locationId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const { table, column } of await directCascadeTables()) {
      const row = await driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?;`,
        [locationId],
      );
      counts[table] = Number(row?.n ?? 0);
    }
    return counts;
  }

  /**
   * The two tables that cascade through a chain rather than straight off `locations`, so
   * {@link directCascadeTables} cannot see them. Listed by hand, and said so.
   */
  async function chainedRowCounts(locationId: string) {
    const row = await driver.queryOne<{ regions: number; placements: number }>(
      `SELECT
         (SELECT COUNT(*) FROM location_regions r
            JOIN location_photos p ON p.id = r.photo_id WHERE p.location_id = ?) AS regions,
         (SELECT COUNT(*) FROM item_regions ir
            JOIN location_regions r ON r.id = ir.region_id
            JOIN location_photos p ON p.id = r.photo_id WHERE p.location_id = ?) AS placements;`,
      [locationId, locationId],
    );
    return { regions: Number(row?.regions ?? 0), placements: Number(row?.placements ?? 0) };
  }

  /**
   * The issue's Garage: it homes no *active* item, so the sidebar's count reads zero — but it has a
   * shelf under it holding 40 units, a photo with a region an item is pinned to, a tag, an
   * inheritable field value, stock lent to it from elsewhere, an open loan, and one removed item
   * still homed there.
   */
  async function garageScenario() {
    const workshop = await locations.create({ name: 'Workshop' });
    const garage = await locations.create({ name: 'Garage', parentId: workshop.id });
    const shelf = await locations.create({ name: 'Shelf', parentId: garage.id });

    const sockets = await items.create({ name: 'Sockets', locationId: shelf.id, quantity: 40 });
    // Homed at the Garage but removed: `location_item_counts` is maintained `WHERE is_active = 1`,
    // so this one is invisible to the sidebar while the delete re-homes it regardless.
    const brokenDrill = await items.create({ name: 'Broken drill', locationId: garage.id });
    await items.softDelete(brokenDrill.id);

    // Stock belonging to an item homed elsewhere, parked in the Garage.
    const ladder = await items.create({ name: 'Ladder', locationId: workshop.id, quantity: 3 });
    await items.transferStock(ladder.id, workshop.id, garage.id, 2);

    const photo = await photos.addPhoto({
      locationId: garage.id,
      fullResOpfsPath: 'photos/garage.jpg',
      naturalWidth: 1000,
      naturalHeight: 800,
      thumbnailBlob: null,
    });
    const region = await photos.addRegion({
      photoId: photo.id,
      name: 'Top shelf',
      shape: 'rect',
      geometry: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
    });
    await photos.linkItem(sockets.id, region.id);

    await tags.setForLocation(garage.id, ['damp']);

    const category = await categories.create({ name: 'Tools' });
    const field = await categories.addField(category.id, { name: 'Shelf note', fieldType: 'TEXT' });
    await categories.setLocationFieldValue(garage.id, {
      defId: field.defId,
      value: 'Back wall',
      isInheritable: true,
    });

    // A tool lent *to* the Garage as the borrower — the delete checks it back in.
    const jack = await items.create({ name: 'Trolley jack', locationId: workshop.id, quantity: 1 });
    await checkouts.checkout({ itemId: jack.id, locationId: garage.id });

    return { workshop, garage, shelf, sockets, brokenDrill, ladder };
  }

  it('counts what the delete will destroy, for a location the sidebar reads as empty', async () => {
    const { garage } = await garageScenario();

    // What the old guard saw, and why one click was enough to lose all of the above.
    const flat = await locations.listAll();
    expect(flat.find((l) => l.id === garage.id)?.itemCount).toBe(0);

    const impact = await locations.getDeleteImpact(garage.id);
    expect(impact).toEqual({
      // The removed drill: invisible to `location_item_counts`, re-homed by the delete.
      itemsHere: 1,
      stockUnitsHere: 2,
      openLoansHere: 1,
      childLocations: 1,
      itemsBelow: 1,
      promotedToName: 'Workshop',
      photos: 1,
      regions: 1,
      tags: 1,
      fieldValues: 1,
      loanRecords: 1,
    });
  });

  it('names every table that cascades directly off a location', async () => {
    // The guard behind this file's parity claim: a new `ON DELETE CASCADE` reference to
    // `locations` turns up here, and fails until `LocationDeleteImpact` counts it too.
    const tables = (await directCascadeTables()).map((t) => t.table);
    expect([...new Set(tables)].sort()).toEqual(Object.keys(CASCADE_FIELD).sort());
  });

  it('counts a location whose only loans have already been returned', async () => {
    // `openLoansHere` is 0 — nothing to check back in — but the checkout rows still name the
    // location, and the borrower FK cascades, so the record of the loan goes with it.
    const van = await locations.create({ name: 'Van' });
    const drill = await items.create({ name: 'Drill', locationId: van.id, quantity: 1 });
    const loan = await checkouts.checkout({ itemId: drill.id, locationId: van.id });
    await checkouts.checkIn(loan.id);

    const impact = await locations.getDeleteImpact(van.id);
    expect(impact.openLoansHere).toBe(0);
    expect(impact.loanRecords).toBe(1);

    await locations.delete(van.id);
    expect((await directRowCounts(van.id)).checkouts).toBe(0);
  });

  it('destroys exactly the rows it said it would, and nothing it said would move', async () => {
    const { workshop, garage, shelf, sockets, brokenDrill, ladder } = await garageScenario();

    const beforeDirect = await directRowCounts(garage.id);
    const beforeChained = await chainedRowCounts(garage.id);
    const impact = await locations.getDeleteImpact(garage.id);
    expect(beforeDirect).toEqual({
      location_photos: 1,
      location_tags: 1,
      location_field_values: 1,
      checkouts: 1,
    });
    expect(beforeChained).toEqual({ regions: 1, placements: 1 });

    await locations.delete(garage.id);

    // Destroyed: every count the impact reported under "destroys" is exactly the drop, for every
    // cascading table the schema knows about rather than for a list written down beside it.
    const afterDirect = await directRowCounts(garage.id);
    const afterChained = await chainedRowCounts(garage.id);
    for (const [table, field] of Object.entries(CASCADE_FIELD)) {
      expect(afterDirect[table], `${table} should be gone`).toBe(0);
      expect(beforeDirect[table]! - afterDirect[table]!, `${table} drop vs impact.${field}`).toBe(
        impact[field],
      );
    }
    expect(afterChained).toEqual({ regions: 0, placements: 0 });
    expect(beforeChained.regions - afterChained.regions).toBe(impact.regions);

    // Moved, not lost: the removed item re-homes, the parked stock re-homes with its total
    // intact, and the child is promoted with its own contents untouched.
    expect((await items.getById(brokenDrill.id))?.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect((await items.getById(sockets.id))?.locationId).toBe(shelf.id);
    expect((await locations.getById(shelf.id))?.parentId).toBe(workshop.id);
    const ladderStock = await items.listStock(ladder.id);
    expect(ladderStock.reduce((sum, p) => sum + p.quantity, 0)).toBe(3);
    expect(ladderStock.find((p) => p.locationId === UNASSIGNED_LOCATION_ID)?.quantity).toBe(2);
    // The shelf's own photos/tags/fields were never in scope: it was promoted, not deleted.
    expect(await chainedRowCounts(shelf.id)).toEqual({ regions: 0, placements: 0 });
  });

  it('reports nothing at all for a location that holds nothing', async () => {
    const empty = await locations.create({ name: 'Spare shelf' });
    expect(await locations.getDeleteImpact(empty.id)).toEqual({
      itemsHere: 0,
      stockUnitsHere: 0,
      openLoansHere: 0,
      childLocations: 0,
      itemsBelow: 0,
      promotedToName: null,
      photos: 0,
      regions: 0,
      tags: 0,
      fieldValues: 0,
      loanRecords: 0,
    });
  });

  it('counts the whole subtree below, not just the direct children', async () => {
    const garage = await locations.create({ name: 'Garage' });
    const bay = await locations.create({ name: 'Bay', parentId: garage.id });
    const rack = await locations.create({ name: 'Rack', parentId: bay.id });
    const bin = await locations.create({ name: 'Bin', parentId: rack.id });
    await items.create({ name: 'Deep thing', locationId: bin.id });
    await items.create({ name: 'Mid thing', locationId: rack.id });

    const impact = await locations.getDeleteImpact(garage.id);
    // One child is promoted; the two items three and four levels down are still worth naming.
    expect(impact.childLocations).toBe(1);
    expect(impact.itemsBelow).toBe(2);
    expect(impact.promotedToName).toBeNull();
  });

  it('yields an all-zero impact for an id that no longer names a location', async () => {
    const impact = await locations.getDeleteImpact('gone');
    expect(impact.itemsHere).toBe(0);
    expect(impact.childLocations).toBe(0);
    expect(impact.photos).toBe(0);
    expect(impact.promotedToName).toBeNull();
  });
});
