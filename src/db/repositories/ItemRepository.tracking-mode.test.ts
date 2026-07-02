import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { isConvertibleTrackingChange } from './constants';
import { ItemRepository } from './ItemRepository';

describe('ItemRepository — in-place tracking-mode change (Bulk ↔ Untracked)', () => {
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

  it('switches DISCRETE → UNTRACKED, preserving quantity and logging TRACKING_CHANGED', async () => {
    const item = await items.create({ name: 'Bench vice', trackingMode: 'DISCRETE', quantity: 12 });

    const updated = await items.update(item.id, { trackingMode: 'UNTRACKED' });
    expect(updated.trackingMode).toBe('UNTRACKED');
    // UNTRACKED merely hides the quantity — the underlying stock is preserved, not zeroed.
    expect(updated.quantity).toBe(12);

    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'TRACKING_CHANGED')).toBe(true);
  });

  it('round-trips UNTRACKED → DISCRETE without losing the on-hand quantity', async () => {
    const item = await items.create({ name: 'Reference manual', trackingMode: 'DISCRETE', quantity: 5 });
    await items.update(item.id, { trackingMode: 'UNTRACKED' });

    const back = await items.update(item.id, { trackingMode: 'DISCRETE' });
    expect(back.trackingMode).toBe('DISCRETE');
    expect(back.quantity).toBe(5);
  });

  it('does not log a change when the tracking mode is set to its current value', async () => {
    const item = await items.create({ name: 'Screws', trackingMode: 'DISCRETE', quantity: 3 });
    await items.update(item.id, { trackingMode: 'DISCRETE' });

    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'TRACKING_CHANGED')).toBe(false);
  });

  it('rejects the lossy conversions to/from SERIALISED and CONSUMABLE_GAUGE', async () => {
    const bulk = await items.create({ name: 'Widget', trackingMode: 'DISCRETE', quantity: 4 });
    await expect(items.update(bulk.id, { trackingMode: 'SERIALISED' })).rejects.toBeInstanceOf(DbError);
    await expect(items.update(bulk.id, { trackingMode: 'CONSUMABLE_GAUGE' })).rejects.toBeInstanceOf(DbError);

    const [serial] = await items.createSerialised({ name: 'Torque wrench', count: 1 });
    await expect(items.update(serial!.id, { trackingMode: 'DISCRETE' })).rejects.toBeInstanceOf(DbError);
    // The rejected item is untouched.
    const reloaded = await items.getById(serial!.id);
    expect(reloaded?.trackingMode).toBe('SERIALISED');
  });

  it('isConvertibleTrackingChange only allows the storage-identical Bulk ↔ Untracked pair', () => {
    expect(isConvertibleTrackingChange('DISCRETE', 'UNTRACKED')).toBe(true);
    expect(isConvertibleTrackingChange('UNTRACKED', 'DISCRETE')).toBe(true);
    expect(isConvertibleTrackingChange('DISCRETE', 'DISCRETE')).toBe(false); // no-op is not a change
    expect(isConvertibleTrackingChange('DISCRETE', 'SERIALISED')).toBe(false);
    expect(isConvertibleTrackingChange('CONSUMABLE_GAUGE', 'UNTRACKED')).toBe(false);
    expect(isConvertibleTrackingChange('SERIALISED', 'DISCRETE')).toBe(false);
  });
});
