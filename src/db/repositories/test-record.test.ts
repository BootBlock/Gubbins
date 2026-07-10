import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { sortTestRecords } from '@/features/inventory/test-records';
import { ItemRepository, TombstoneRepository, UNASSIGNED_LOCATION_ID } from './index';

/**
 * Per-instance test / calibration / service records (feature-gap G7). Exercises the repository
 * seam: recording appends a `test_records` row *and* a `TESTED` Activity-Log entry in one
 * transaction, the log is newest-first, kind/result normalise through the pure seam, a blank name
 * or non-finite reading is rejected, removal DELETE+tombstones (and is a no-op for an unknown id),
 * a hard-delete cascades the log + tombstones the item, and the repo's SQL order matches the pure
 * `sortTestRecords` seam.
 */
describe('Test records (feature-gap G7)', () => {
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
    const item = await items.create({
      name: 'Insulation tester',
      locationId: UNASSIGNED_LOCATION_ID,
      trackingMode: 'SERIALISED',
    });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('records a result: appends a row with normalised content', async () => {
    const rec = await items.recordTestResult(itemId, {
      kind: ' calibration ',
      name: '  Annual calibration ',
      result: 'limit',
      reading: 0.4,
      unit: ' % ',
      note: ' within tolerance ',
    });
    expect(rec).toMatchObject({
      itemId,
      kind: 'CALIBRATION',
      name: 'Annual calibration',
      result: 'LIMIT',
      reading: 0.4,
      unit: '%',
      note: 'within tolerance',
    });

    const log = await items.listTestRecords(itemId);
    expect(log).toHaveLength(1);
    expect(log[0]?.id).toBe(rec.id);
  });

  it('applies defaults for omitted kind/result', async () => {
    const rec = await items.recordTestResult(itemId, { name: 'Quick check' });
    expect(rec.kind).toBe('TEST');
    expect(rec.result).toBe('PASS');
    expect(rec.reading).toBeNull();
    expect(rec.unit).toBeNull();
  });

  it('defaults performedAt to now when omitted', async () => {
    const before = Date.now();
    const rec = await items.recordTestResult(itemId, { name: 'Now check' });
    const after = Date.now();
    expect(rec.performedAt).toBeGreaterThanOrEqual(before);
    expect(rec.performedAt).toBeLessThanOrEqual(after);
  });

  it('lists newest first (by performed_at)', async () => {
    await items.recordTestResult(itemId, { name: 'First', performedAt: 1_000 });
    await items.recordTestResult(itemId, { name: 'Third', performedAt: 3_000 });
    await items.recordTestResult(itemId, { name: 'Second', performedAt: 2_000 });
    const log = await items.listTestRecords(itemId);
    expect(log.map((r) => r.name)).toEqual(['Third', 'Second', 'First']);
  });

  it('matches the pure sortTestRecords order (SQL ↔ seam equivalence)', async () => {
    await items.recordTestResult(itemId, { name: 'A', performedAt: 2_000 });
    await items.recordTestResult(itemId, { name: 'B', performedAt: 2_000 });
    await items.recordTestResult(itemId, { name: 'C', performedAt: 5_000 });
    const log = await items.listTestRecords(itemId);
    expect(log.map((r) => r.id)).toEqual(sortTestRecords(log).map((r) => r.id));
  });

  it('rejects a blank name or a non-finite reading', async () => {
    await expect(items.recordTestResult(itemId, { name: '   ' })).rejects.toThrow();
    await expect(items.recordTestResult(itemId, { name: 'Bad', reading: Number.NaN })).rejects.toThrow();
  });

  it('throws when recording against a non-existent item', async () => {
    await expect(items.recordTestResult('does-not-exist', { name: 'X' })).rejects.toThrow();
  });

  it('records a TESTED entry on the Activity Log', async () => {
    await items.recordTestResult(itemId, { name: 'Insulation', result: 'PASS' });
    const history = await items.getHistory(itemId);
    expect(history.rows.some((h) => h.action === 'TESTED')).toBe(true);
  });

  it('removes a record via DELETE + tombstone', async () => {
    const rec = await items.recordTestResult(itemId, { name: 'Mistake' });
    await items.removeTestRecord(rec.id);
    expect(await items.listTestRecords(itemId)).toHaveLength(0);
    expect(await tombstones.has('test_records', rec.id)).toBe(true);
  });

  it('is a genuine no-op when removing an unknown id (no stray tombstone)', async () => {
    await items.removeTestRecord('never-existed');
    expect(await tombstones.has('test_records', 'never-existed')).toBe(false);
  });

  it('cascades the records and tombstones the item on hard delete', async () => {
    await items.recordTestResult(itemId, { name: 'Gone with the item' });
    await items.hardDelete(itemId);
    const rows = await driver.query('SELECT * FROM test_records WHERE item_id = ?;', [itemId]);
    expect(rows).toHaveLength(0);
    expect(await tombstones.has('items', itemId)).toBe(true);
  });
});
