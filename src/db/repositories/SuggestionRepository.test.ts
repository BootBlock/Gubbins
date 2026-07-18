import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, SuggestionRepository, UNASSIGNED_LOCATION_ID } from './index';

describe('SuggestionRepository — distinct existing field values', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let repo: SuggestionRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    repo = new SuggestionRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('returns distinct manufacturers already entered, case-insensitively sorted', async () => {
    await items.create({ name: 'A', locationId: UNASSIGNED_LOCATION_ID, manufacturer: 'Yageo' });
    await items.create({ name: 'B', locationId: UNASSIGNED_LOCATION_ID, manufacturer: 'Bourns' });
    await items.create({ name: 'C', locationId: UNASSIGNED_LOCATION_ID, manufacturer: 'Yageo' });

    expect(await repo.distinctValues('manufacturer')).toEqual(['Bourns', 'Yageo']);
  });

  it('excludes items with no manufacturer set (null)', async () => {
    await items.create({ name: 'A', locationId: UNASSIGNED_LOCATION_ID, manufacturer: 'Murata' });
    await items.create({ name: 'B', locationId: UNASSIGNED_LOCATION_ID }); // no manufacturer

    expect(await repo.distinctValues('manufacturer')).toEqual(['Murata']);
  });

  it('reads the gauge unit-of-measure column', async () => {
    await items.create({
      name: 'Filament',
      locationId: UNASSIGNED_LOCATION_ID,
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });

    expect(await repo.distinctValues('unitOfMeasure')).toEqual(['g']);
  });

  // Supplier names are no longer a free-text suggestion field: suppliers are a first-class
  // entity (issue #384), so the supplier dictionary itself is what offers existing names.

  it('returns an empty list when nothing has been entered yet', async () => {
    expect(await repo.distinctValues('manufacturer')).toEqual([]);
  });
});
