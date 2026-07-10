import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, TombstoneRepository, UNASSIGNED_LOCATION_ID } from './index';

/**
 * Manual current value + revaluation log (feature-gap G9). Exercises the repository seam:
 * recording a revaluation appends a log point *and* sets the live `items.current_value` in one
 * transaction, the log is newest-first, `current_value` seeds via create + clears via update,
 * and a hard-delete cascades the log + records the item tombstone.
 */
describe('Revaluations (feature-gap G9)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let tombstones: TombstoneRepository;
  let itemId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    tombstones = new TombstoneRepository(driver);
    const item = await items.create({ name: 'Vintage synth', locationId: UNASSIGNED_LOCATION_ID });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('defaults current_value to null on a freshly created item', async () => {
    const item = await items.getById(itemId);
    expect(item?.currentValue).toBeNull();
  });

  it('seeds current_value at creation without a log entry', async () => {
    const created = await items.create({
      name: 'Seeded asset',
      locationId: UNASSIGNED_LOCATION_ID,
      currentValue: 1200,
    });
    expect(created.currentValue).toBe(1200);
    expect(await items.listRevaluations(created.id)).toEqual([]);
  });

  it('records a revaluation: appends a log point and sets the live current value', async () => {
    const entry = await items.recordRevaluation(itemId, { value: 900, note: 'Restored to working order' });
    expect(entry.value).toBe(900);
    expect(entry.note).toBe('Restored to working order');
    expect(entry.itemId).toBe(itemId);

    const item = await items.getById(itemId);
    expect(item?.currentValue).toBe(900);

    const log = await items.listRevaluations(itemId);
    expect(log).toHaveLength(1);
    expect(log[0]?.value).toBe(900);
  });

  it('supports up and down revaluations, with current_value tracking the newest', async () => {
    await items.recordRevaluation(itemId, { value: 500, revaluedAt: 1_000 });
    await items.recordRevaluation(itemId, { value: 750, revaluedAt: 2_000 }); // appreciated
    await items.recordRevaluation(itemId, { value: 600, revaluedAt: 3_000 }); // marked down

    const item = await items.getById(itemId);
    expect(item?.currentValue).toBe(600);

    const log = await items.listRevaluations(itemId);
    // Newest first.
    expect(log.map((r) => r.value)).toEqual([600, 750, 500]);
  });

  it('defaults revaluedAt to now when omitted', async () => {
    const before = Date.now();
    const entry = await items.recordRevaluation(itemId, { value: 42 });
    const after = Date.now();
    expect(entry.revaluedAt).toBeGreaterThanOrEqual(before);
    expect(entry.revaluedAt).toBeLessThanOrEqual(after);
  });

  it('rejects a negative or non-finite revaluation', async () => {
    await expect(items.recordRevaluation(itemId, { value: -1 })).rejects.toThrow();
    await expect(items.recordRevaluation(itemId, { value: Number.NaN })).rejects.toThrow();
  });

  it('throws when revaluing a non-existent item', async () => {
    await expect(items.recordRevaluation('does-not-exist', { value: 10 })).rejects.toThrow();
  });

  it('clears the manual value via update without wiping the log', async () => {
    await items.recordRevaluation(itemId, { value: 300 });
    await items.update(itemId, { currentValue: null });

    const item = await items.getById(itemId);
    expect(item?.currentValue).toBeNull();
    // The historical log is preserved (append-only).
    expect(await items.listRevaluations(itemId)).toHaveLength(1);
  });

  it('records a REVALUED entry on the Activity Log', async () => {
    await items.recordRevaluation(itemId, { value: 250 });
    const history = await items.getHistory(itemId);
    expect(history.rows.some((h) => h.action === 'REVALUED')).toBe(true);
  });

  it('cascades the revaluation log and tombstones the item on hard delete', async () => {
    await items.recordRevaluation(itemId, { value: 400 });
    await items.hardDelete(itemId);

    const rows = await driver.query('SELECT * FROM revaluations WHERE item_id = ?;', [itemId]);
    expect(rows).toHaveLength(0);
    expect(await tombstones.has('items', itemId)).toBe(true);
  });
});
