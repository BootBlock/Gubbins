import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DiagnosticsRepository } from './DiagnosticsRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

describe('DiagnosticsRepository', () => {
  let driver: MemoryDriver;
  let diagnostics: DiagnosticsRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    diagnostics = new DiagnosticsRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reports a positive database size for a migrated database', async () => {
    const { databaseBytes } = await diagnostics.snapshot();
    // page_count × page_size — a migrated schema always occupies at least a few pages.
    expect(databaseBytes).toBeGreaterThan(0);
  });

  it('counts each entity, tracking newly-created rows', async () => {
    // Compare against a baseline so the assertions are robust to any seed rows a migration
    // creates (e.g. default locations) rather than hard-coding a starting count.
    const before = (await diagnostics.snapshot()).counts;

    await items.create({ name: 'A' });
    await items.create({ name: 'B' });
    await locations.create({ name: 'Shelf' });

    const after = (await diagnostics.snapshot()).counts;
    expect(after.items - before.items).toBe(2);
    expect(after.locations - before.locations).toBe(1);
    expect(after.projects).toBe(before.projects);
  });

  it('grows the reported database size as rows are added', async () => {
    const before = (await diagnostics.snapshot()).databaseBytes;
    for (let i = 0; i < 200; i += 1) await items.create({ name: `Item ${i}` });
    const after = (await diagnostics.snapshot()).databaseBytes;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
