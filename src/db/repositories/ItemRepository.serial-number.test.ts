import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';

/**
 * Intrinsic serial number (issue #90) — the maker's per-unit identifier, distinct from the
 * SERIALISED-clone `serialNo` instance index. Stored verbatim, cleared by null, and FTS-searchable.
 */
describe('ItemRepository — serial number', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('persists a serial number on create and clears it on update', async () => {
    const item = await items.create({ name: 'Cordless drill', serialNumber: 'SN-2024-0042' });
    expect(item.serialNumber).toBe('SN-2024-0042');
    const cleared = await items.update(item.id, { serialNumber: null });
    expect(cleared.serialNumber).toBeNull();
    // A blank serial normalises to null, never an empty string.
    const blank = await items.create({ name: 'No serial', serialNumber: '   ' });
    expect(blank.serialNumber).toBeNull();
  });

  it('is independent of the SERIALISED-clone serialNo instance index', async () => {
    // A serial number applies to any item regardless of tracking mode, and does not populate
    // the `serialNo` clone index (which only the SERIALISED auto-clone path sets).
    const item = await items.create({ name: 'Bulk part', serialNumber: 'ABC-123' });
    expect(item.serialNumber).toBe('ABC-123');
    expect(item.serialNo).toBeNull();
  });

  it('makes the serial number findable via full-text search', async () => {
    const item = await items.create({ name: 'Boxed asset', serialNumber: 'X99-ZZ-7788' });
    const page = await items.list({ search: 'X99-ZZ-7788' });
    expect(page.rows.map((r) => r.id)).toContain(item.id);
  });
});
