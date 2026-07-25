import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SettingsRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';

/**
 * Issue #382 — the synced `settings` table round-trips between two devices (§7.3).
 *
 * The point of interest is what makes this table unlike every other one: its `id` is **derived**
 * from (store, field) rather than random, so both devices name the same preference with the same row
 * id. That is what turns "my theme" and "your theme" into one row LWW can resolve, instead of two
 * rows that would accumulate one per device — and it is worth a round-trip test precisely because a
 * mistake there looks like a working sync until a second device joins.
 */
async function makeDevice(): Promise<{ driver: MemoryDriver; settings: SettingsRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, settings: new SettingsRepository(driver) };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

/** The stored value of one preference on one device, or undefined when it has no row. */
async function valueOf(device: { settings: SettingsRepository }, field: string): Promise<unknown> {
  const row = (await device.settings.list()).find((r) => r.field === field);
  return row === undefined ? undefined : JSON.parse(row.value);
}

describe('shared settings sync round-trip (§7.3)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('publishes a shared preference, then a peer pulls it', async () => {
    await a.settings.publish([
      { storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' },
      { storeKey: 'gubbins:layout', field: 'density', value: '"data"' },
    ]);

    expect((await runSync(a.driver, provider, NO_QUOTA)).status).toBe('PUBLISHED');
    expect((await runSync(b.driver, provider, NO_QUOTA)).status).toBe('SYNCED');

    expect(await valueOf(b, 'mode')).toBe('light');
    expect(await valueOf(b, 'density')).toBe('data');
    // The row id is derived, so it arrives naming the same preference it left as.
    expect((await b.settings.list()).map((r) => r.id)).toEqual([
      'gubbins:layout#density',
      'gubbins:preferences#mode',
    ]);
  });

  it('resolves the same preference changed on both devices to the later change', async () => {
    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' }]);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // The derived id means this is an *edit of the same row*, not a second row — so Last-Write-Wins
    // has something to resolve, and B's later change wins on both devices.
    await b.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"system"' }]);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    expect(await valueOf(a, 'mode')).toBe('system');
    expect(await a.settings.list()).toHaveLength(1);
  });

  it('keeps two different preferences apart, so one device’s change cannot clobber another’s', async () => {
    // The failure the issue was raised about: with the preferences held as one blob, changing the
    // theme on a phone would discard the threshold tuned on a desktop. One row per preference is
    // what makes both survive.
    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' }]);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"dark"' }]);
    await b.settings.publish([
      { storeKey: 'gubbins:preferences', field: 'lowStockQtyThreshold', value: '7' },
    ]);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    expect(await valueOf(a, 'mode')).toBe('dark');
    expect(await valueOf(a, 'lowStockQtyThreshold')).toBe(7);
    expect(await valueOf(b, 'mode')).toBe('dark');
    expect(await valueOf(b, 'lowStockQtyThreshold')).toBe(7);
  });

  it('does not re-stamp a row when publishing the value it already holds', async () => {
    // The trigger stamps any UPDATE, so a no-op write would make this device look like the more
    // recent editor and set the two pushing an unchanged row back and forth (issue #161).
    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' }]);
    const before = (await a.settings.list())[0]!.updated_at;

    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' }]);
    expect((await a.settings.list())[0]!.updated_at).toBe(before);
  });

  it('stamps a row that genuinely changed', async () => {
    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"light"' }]);
    const before = (await a.settings.list())[0]!.updated_at;

    await a.settings.publish([{ storeKey: 'gubbins:preferences', field: 'mode', value: '"dark"' }]);
    const after = (await a.settings.list())[0]!;
    expect(after.value).toBe('"dark"');
    expect(after.updated_at).toBeGreaterThan(before);
  });
});
