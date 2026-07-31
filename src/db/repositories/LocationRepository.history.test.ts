import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { LocationRepository } from './LocationRepository';
import { ItemRepository } from './ItemRepository';
import { ADMIN_USER_ID } from './constants';

/**
 * The location activity record (issue #691). The behaviours worth pinning are the ones a plain
 * read of the write path cannot show: that only hierarchy-reshaping changes are recorded, that a
 * no-op save records nothing, that a deletion survives the row it describes, and — the one that
 * would otherwise be a silent lie in an audit trail — that a cycle-vetoed move records nothing.
 */
describe('LocationRepository activity record (#691)', () => {
  let driver: MemoryDriver;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  const actionsFor = async (id: string) => (await locations.getHistory(id)).rows.map((e) => e.action);

  it('records creation, attributed and named', async () => {
    const workshop = await locations.create({ name: 'Workshop' });

    const { rows } = await locations.getHistory(workshop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      locationId: workshop.id,
      locationName: 'Workshop',
      action: 'CREATED',
      actorUserId: ADMIN_USER_ID,
    });
    expect(rows[0]!.note).toContain('Workshop');
  });

  it('records a rename with both names, and carries the new name on the entry', async () => {
    const shelf = await locations.create({ name: 'Shelf B' });
    await locations.update(shelf.id, { name: 'Shelf C' });

    const [latest] = (await locations.getHistory(shelf.id)).rows;
    expect(latest).toMatchObject({ action: 'RENAMED', locationName: 'Shelf C' });
    expect(latest!.note).toBe('Renamed from "Shelf B" to "Shelf C".');
    expect(latest!.metadata).toEqual({ fromName: 'Shelf B', toName: 'Shelf C' });
  });

  it('records a re-parent by name, and names the root honestly', async () => {
    const workshop = await locations.create({ name: 'Workshop' });
    const garage = await locations.create({ name: 'Garage' });
    const shelf = await locations.create({ name: 'Shelf', parentId: workshop.id });

    await locations.update(shelf.id, { parentId: garage.id });
    await locations.update(shelf.id, { parentId: null });

    const notes = (await locations.getHistory(shelf.id)).rows.map((e) => e.note);
    expect(notes[0]).toBe('Moved from "Garage" to the top level.');
    expect(notes[1]).toBe('Moved from "Workshop" to "Garage".');
  });

  it('records archiving and restoring as the two directions of one toggle', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    await locations.setArchived(shelf.id, true);
    await locations.setArchived(shelf.id, false);

    expect(await actionsFor(shelf.id)).toEqual(['RESTORED', 'ARCHIVED', 'CREATED']);
  });

  it('records nothing for a save that changes nothing, or that only changes presentation', async () => {
    const shelf = await locations.create({ name: 'Shelf' });

    // Same name, same parent — a Save with no net change is not an event.
    await locations.update(shelf.id, { name: 'Shelf', parentId: null });
    // Colour, capacity, walk order and the dead-stock policy describe the place; they do not
    // reshape the hierarchy, so this first pass deliberately records none of them.
    await locations.update(shelf.id, {
      color: 'teal',
      capacity: 20,
      walkOrder: 3,
      deadStockMode: 'always',
    });
    // Re-archiving an already-archived location is not a second archiving.
    await locations.setArchived(shelf.id, true);
    await locations.update(shelf.id, { archivedAt: Date.now() });

    expect(await actionsFor(shelf.id)).toEqual(['ARCHIVED', 'CREATED']);
  });

  it('records nothing for a rejected cyclical move', async () => {
    const parent = await locations.create({ name: 'Parent' });
    const child = await locations.create({ name: 'Child', parentId: parent.id });

    // Moving the parent under its own child is a cycle. This one is stopped by the pre-check
    // before any transaction runs; the guarded-INSERT path that covers the racing case is
    // exercised directly in `location-history.test.ts`.
    await expect(locations.update(parent.id, { name: 'Renamed', parentId: child.id })).rejects.toThrow();

    expect(await actionsFor(parent.id)).toEqual(['CREATED']);
    expect((await locations.getById(parent.id))!.name).toBe('Parent');
  });

  it('keeps a deleted location’s record, still naming which location it was about', async () => {
    const items = new ItemRepository(driver);
    const workshop = await locations.create({ name: 'Workshop' });
    const shelf = await locations.create({ name: 'Shelf B', parentId: workshop.id });
    await items.create({ name: 'Widget', locationId: shelf.id });
    await locations.update(shelf.id, { name: 'Shelf C' });

    await locations.delete(shelf.id);

    // The subject column is a historical coordinate, not a foreign key, so the whole trail
    // outlives the row it describes — id intact, so a `location.removed` subscriber can act on it.
    const kept = (await locations.getHistory(shelf.id)).rows;
    expect(kept.map((e) => e.action)).toEqual(['DELETED', 'RENAMED', 'CREATED']);
    expect(kept.every((e) => e.locationId === shelf.id)).toBe(true);
    expect(kept[0]!.locationName).toBe('Shelf C');
    expect(kept[0]!.note).toContain('1 item was moved to Unassigned');
    expect(kept[0]!.note).toContain('0 sub-locations were moved to "Workshop"');
    // …and the location itself really is gone, so this is a record of something that no longer is.
    expect(await locations.getById(shelf.id)).toBeUndefined();
  });

  it('records the move on each sub-location a delete promotes', async () => {
    const room = await locations.create({ name: 'Room' });
    const shelf = await locations.create({ name: 'Shelf', parentId: room.id });

    await locations.delete(room.id);

    // The one re-parent nobody asked for — and therefore the one most likely to prompt "why is
    // this shelf suddenly somewhere else?".
    const [latest] = (await locations.getHistory(shelf.id)).rows;
    expect(latest).toMatchObject({ action: 'RE_PARENTED', locationId: shelf.id, locationName: 'Shelf' });
    expect(latest!.note).toBe('Moved from "Room" to the top level: "Room" was deleted.');
    expect(latest!.metadata).toEqual({ fromParentId: room.id, toParentId: null });
    expect((await locations.getById(shelf.id))!.parentId).toBeNull();
  });

  it('feeds every location newest-first for the cross-location scan', async () => {
    const first = await locations.create({ name: 'First' });
    const second = await locations.create({ name: 'Second' });
    await locations.update(first.id, { name: 'First renamed' });

    const feed = await locations.getHistoryFeed({ limit: 2 });
    expect(feed.rows.map((e) => e.action)).toEqual(['RENAMED', 'CREATED']);
    expect(feed.rows[1]!.locationId).toBe(second.id);
    expect(feed.hasMore).toBe(true);
  });

  /**
   * The cross-location feed's filter and count (issue #693) — what the Activity screen's Locations
   * lane reads. The count is the denominator its paginated mode sizes pages from, so the two must
   * agree about what the filter matches; a count that disagreed would offer pages that are empty
   * or hide pages that are not.
   */
  describe('cross-location feed filter + count (#693)', () => {
    it('filters the feed by action, and counts exactly what the filter matches', async () => {
      const shelf = await locations.create({ name: 'Shelf' });
      await locations.create({ name: 'Bin' });
      await locations.update(shelf.id, { name: 'Top shelf' });

      const renames = await locations.getHistoryFeed({ actions: ['RENAMED'] });
      expect(renames.rows.map((e) => e.locationName)).toEqual(['Top shelf']);
      expect(await locations.countHistoryFeed({ actions: ['RENAMED'] })).toBe(1);

      const both = await locations.getHistoryFeed({ actions: ['RENAMED', 'CREATED'] });
      expect(both.rows).toHaveLength(3);
      expect(await locations.countHistoryFeed({ actions: ['RENAMED', 'CREATED'] })).toBe(3);
    });

    it('treats an omitted filter as the whole feed and an empty one as nothing', async () => {
      await locations.create({ name: 'Shelf' });

      expect((await locations.getHistoryFeed()).rows).toHaveLength(1);
      expect(await locations.countHistoryFeed()).toBe(1);
      expect(await locations.countHistoryFeed({})).toBe(1);

      // De-selecting every chip must show an empty lane, not silently fall back to everything.
      expect((await locations.getHistoryFeed({ actions: [] })).rows).toEqual([]);
      expect(await locations.countHistoryFeed({ actions: [] })).toBe(0);
    });

    it('still counts and feeds a deleted location’s entries — the lane’s whole reason to exist', async () => {
      const shelf = await locations.create({ name: 'Top shelf' });
      await locations.delete(shelf.id);

      // Nothing is left to open this from, so the cross-location read is the only in-app reader.
      const feed = await locations.getHistoryFeed({ actions: ['DELETED'] });
      expect(feed.rows.map((e) => e.locationName)).toEqual(['Top shelf']);
      expect(await locations.countHistoryFeed({ actions: ['DELETED'] })).toBe(1);
      expect(await locations.getById(shelf.id)).toBeUndefined();
    });

    it('counts the whole feed, not the page the caller asked for', async () => {
      for (const name of ['A', 'B', 'C']) await locations.create({ name });

      const firstPage = await locations.getHistoryFeed({ limit: 2 });
      expect(firstPage.rows).toHaveLength(2);
      expect(await locations.countHistoryFeed()).toBe(3);
    });
  });
});
