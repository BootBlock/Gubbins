import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, LocationRepository } from '@/db/repositories';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import {
  mergeSnapshot,
  runSnapshotMerge,
  type SnapshotMergeRequest,
  type SnapshotMergeResult,
} from './merge';
import { buildLocalSnapshot, shiftSnapshotTimestamps } from './snapshot';
import type { SyncSnapshot } from './types';

async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return { driver, items: new ItemRepository(driver) };
}

function request(overrides: Partial<SnapshotMergeRequest> = {}): SnapshotMergeRequest {
  return {
    mode: 'publish',
    remote: null,
    offset: 0,
    effectiveNow: 1_000_000,
    lastSyncTimestamp: 0,
    historyPrunedBefore: 0,
    forceTies: false,
    ...overrides,
  };
}

describe('mergeSnapshot capability seam (issue #173)', () => {
  let device: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    device = await makeDevice();
  });

  afterEach(async () => {
    await device.driver.close();
  });

  it('delegates to the driver when it can run the merge off the main thread', async () => {
    const outcome = { merged: { tables: {} } as unknown as SyncSnapshot } as SnapshotMergeResult;
    const snapshotMerge = vi.fn().mockResolvedValue(outcome);
    const offThread = Object.assign(Object.create(device.driver) as IDatabaseDriver, { snapshotMerge });

    const req = request();
    await expect(mergeSnapshot(offThread, req)).resolves.toBe(outcome);
    expect(snapshotMerge).toHaveBeenCalledWith(req);
  });

  it('runs the merge in-process on a driver without the capability', async () => {
    // The `:memory:` driver has no worker to delegate to, which is precisely why the fallback
    // exists — the whole test suite (and any such driver) must still merge correctly.
    expect('snapshotMerge' in device.driver).toBe(false);

    const { merged } = await mergeSnapshot(device.driver, request());
    expect(merged.tables.items).toEqual([]);
  });
});

describe('runSnapshotMerge clock frames (§7.3.1)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('returns the merged snapshot already normalised to server time, ready to push', async () => {
    await a.items.create({ name: 'Torque wrench', locationId: undefined });
    const offset = 5_000;

    const { merged } = await runSnapshotMerge(a.driver, request({ offset }));

    // The merge owns both frame conversions now, so what comes back is push-ready: every
    // `updated_at` is the stored local value plus the offset, with no further shift needed.
    const local = await buildLocalSnapshot(a.driver, 1_000_000);
    expect(merged.tables.items).toEqual(shiftSnapshotTimestamps(local, offset).tables.items);
    expect(Number(merged.tables.items![0]!.updated_at)).toBe(
      Number(local.tables.items![0]!.updated_at) + offset,
    );
  });

  it('shifts an incoming server-time remote into the local frame before diffing', async () => {
    const created = await b.items.create({ name: 'Feeler gauges', locationId: undefined });
    // A remote as it arrives off the wire: server time, i.e. local + offset.
    const offset = 5_000;
    const remote = shiftSnapshotTimestamps(await buildLocalSnapshot(b.driver, 1_000_000), offset);

    const result = await runSnapshotMerge(
      a.driver,
      request({ mode: 'delta', remote, offset, lastSyncTimestamp: 0 }),
    );

    // Downloaded and stored in *this* device's frame — the +offset the wire carried is undone,
    // so the row's stored timestamp matches the peer's own rather than drifting by the offset.
    // Seeded dictionary rows travel alongside it, so assert the item arrived rather than a total.
    expect(result.pulled).toBeGreaterThan(0);
    const stored = await a.driver.query<{ updated_at: number }>(
      'SELECT updated_at FROM items WHERE id = ?;',
      [created.id],
    );
    const peer = await b.driver.query<{ updated_at: number }>('SELECT updated_at FROM items WHERE id = ?;', [
      created.id,
    ]);
    expect(Number(stored[0]!.updated_at)).toBe(Number(peer[0]!.updated_at));
  });
});

describe('runSnapshotMerge modes', () => {
  let device: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    device = await makeDevice();
  });

  afterEach(async () => {
    await device.driver.close();
  });

  it('refuses a delta merge with no remote rather than silently publishing over it', async () => {
    await expect(runSnapshotMerge(device.driver, request({ mode: 'delta', remote: null }))).rejects.toThrow(
      /requires a remote snapshot/,
    );
  });

  it('reports a publish as a pure read: nothing pulled, deleted or reparented', async () => {
    const locations = new LocationRepository(device.driver);
    await locations.create({ name: 'Workshop' });

    const result = await runSnapshotMerge(device.driver, request({ mode: 'publish' }));

    expect(result.merged.tables.locations).toHaveLength(1);
    expect(result).toMatchObject({ pulled: 0, deleted: 0, reparented: 0, conflicts: [] });
  });
});
