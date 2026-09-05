/**
 * Parity between what {@link LocationRepository.getDeleteImpact} *claims* a delete will do and what
 * {@link LocationRepository.delete} actually does (issue #823).
 *
 * The impact read is a promise made to the user at the one moment they cannot take it back, so it
 * is not enough to assert the counts in isolation: the doc comment on `LocationDeleteImpact` says
 * "these rows are destroyed", and prose cannot hold that together with the SQL that destroys them.
 * So every test here drives *both* sides — it counts the rows, reads the impact, runs the real
 * delete against the real schema, and counts again. Add a cascade the impact does not name, or
 * narrow one of its sub-selects, and the before/after arithmetic disagrees.
 *
 * The scenario is the one from the issue: a Garage that homes nothing the sidebar can see, but that
 * carries a whole photographed, region-mapped, tagged branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { LocationRepository } from './LocationRepository';
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

  /** How many rows each cascaded table holds for one location — the "what is destroyed" tally. */
  async function attachedRowCounts(locationId: string) {
    const row = await driver.queryOne<{
      photos: number;
      regions: number;
      placements: number;
      tags: number;
      field_values: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM location_photos WHERE location_id = ?) AS photos,
         (SELECT COUNT(*) FROM location_regions r
            JOIN location_photos p ON p.id = r.photo_id WHERE p.location_id = ?) AS regions,
         (SELECT COUNT(*) FROM item_regions ir
            JOIN location_regions r ON r.id = ir.region_id
            JOIN location_photos p ON p.id = r.photo_id WHERE p.location_id = ?) AS placements,
         (SELECT COUNT(*) FROM location_tags WHERE location_id = ?) AS tags,
         (SELECT COUNT(*) FROM location_field_values WHERE location_id = ?) AS field_values;`,
      [locationId, locationId, locationId, locationId, locationId],
    );
    return {
      photos: Number(row?.photos ?? 0),
      regions: Number(row?.regions ?? 0),
      placements: Number(row?.placements ?? 0),
      tags: Number(row?.tags ?? 0),
      fieldValues: Number(row?.field_values ?? 0),
    };
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
    });
  });

  it('destroys exactly the rows it said it would, and nothing it said would move', async () => {
    const { workshop, garage, shelf, sockets, brokenDrill, ladder } = await garageScenario();

    const before = await attachedRowCounts(garage.id);
    const impact = await locations.getDeleteImpact(garage.id);
    expect(before).toEqual({ photos: 1, regions: 1, placements: 1, tags: 1, fieldValues: 1 });

    await locations.delete(garage.id);

    // Destroyed: every count the impact reported under "destroys" is exactly the drop.
    const after = await attachedRowCounts(garage.id);
    expect(after).toEqual({ photos: 0, regions: 0, placements: 0, tags: 0, fieldValues: 0 });
    expect(before.photos - after.photos).toBe(impact.photos);
    expect(before.regions - after.regions).toBe(impact.regions);
    expect(before.tags - after.tags).toBe(impact.tags);
    expect(before.fieldValues - after.fieldValues).toBe(impact.fieldValues);

    // Moved, not lost: the removed item re-homes, the parked stock re-homes with its total
    // intact, and the child is promoted with its own contents untouched.
    expect((await items.getById(brokenDrill.id))?.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect((await items.getById(sockets.id))?.locationId).toBe(shelf.id);
    expect((await locations.getById(shelf.id))?.parentId).toBe(workshop.id);
    const ladderStock = await items.listStock(ladder.id);
    expect(ladderStock.reduce((sum, p) => sum + p.quantity, 0)).toBe(3);
    expect(ladderStock.find((p) => p.locationId === UNASSIGNED_LOCATION_ID)?.quantity).toBe(2);
    // The shelf's own photos/tags/fields were never in scope: it was promoted, not deleted.
    expect(await attachedRowCounts(shelf.id)).toEqual({
      photos: 0,
      regions: 0,
      placements: 0,
      tags: 0,
      fieldValues: 0,
    });
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
