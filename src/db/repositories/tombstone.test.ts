import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from './constants';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ContactRepository } from './ContactRepository';
import { TombstoneRepository } from './tombstone';

describe('TombstoneRepository & hard-delete wiring (§7.2)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;
  let contacts: ContactRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    contacts = new ContactRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('records an item tombstone atomically on hard delete', async () => {
    const item = await items.create({ name: 'Doomed', locationId: UNASSIGNED_LOCATION_ID });
    await items.hardDelete(item.id);

    expect(await items.getById(item.id)).toBeUndefined();
    expect(await tombstones.has('items', item.id)).toBe(true);
  });

  it('records a location tombstone on delete while re-parenting its items', async () => {
    const loc = await locations.create({ name: 'Shelf' });
    const item = await items.create({ name: 'On the shelf', locationId: loc.id });

    await locations.delete(loc.id);

    expect(await tombstones.has('locations', loc.id)).toBe(true);
    // The re-parented item survives (no tombstone) and moves to Unassigned.
    const moved = await items.getById(item.id);
    expect(moved?.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect(await tombstones.has('items', item.id)).toBe(false);
  });

  it('records a contact tombstone on delete', async () => {
    const contact = await contacts.create({ name: 'Borrower' });
    await contacts.delete(contact.id);
    expect(await tombstones.has('contacts', contact.id)).toBe(true);
  });

  it('prunes tombstones older than the cutoff and keeps newer ones', async () => {
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'old', 1000);",
    );
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'new', 9000);",
    );

    const removed = await tombstones.pruneOlderThan(5000);
    expect(removed).toBe(1);
    expect(await tombstones.has('items', 'old')).toBe(false);
    expect(await tombstones.has('items', 'new')).toBe(true);
  });

  it('lists tombstones recorded at or after a timestamp (for sync push)', async () => {
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'a', 100);",
    );
    await driver.execute(
      "INSERT INTO tombstones (table_name, id, deleted_at) VALUES ('items', 'b', 300);",
    );
    const since = await tombstones.listSince(200);
    expect(since.map((t) => t.id)).toEqual(['b']);
  });
});
