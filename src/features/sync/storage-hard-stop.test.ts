/**
 * Issue #200: the §7.6.1 Hard Stop reaches the bulk write paths, not just repository writes.
 *
 * A snapshot restore builds its own statements and hands them straight to
 * `driver.transaction(...)`, so `BaseRepository.assertWritable()` never saw it. This asserts the
 * gate now refuses such a write at the locked tier — and, importantly, that it refuses it
 * *before* the driver is touched, so nothing partial reaches a database that has no room.
 *
 * A sync pass has its own §7.4 pre-flight in `./sync-engine`, which used to abort purely on a
 * fresh estimate at the *critical* threshold. That was sufficient only while the locked tier
 * implied a ratio above it; issue #504 makes the Hard Stop reachable at any ratio at all, so the
 * pre-flight has to consult the tier as well — covered below.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setStorageWriteGate, writeSuspendedError } from '@/features/storage/write-gate';
import { useStorageStore } from '@/state/stores/useStorageStore';
import type { CloudProvider } from './types';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { restoreSnapshot } from './snapshot';
import { runSync } from './sync-engine';
import type { SyncSnapshot } from './types';

afterEach(() => {
  setStorageWriteGate(null);
  useStorageStore.setState({ tier: 'ok', measuredTier: 'ok', exhaustion: null });
});

/** A driver that fails the test if the gate lets anything through to it. */
function unusableDriver(): IDatabaseDriver {
  const refuse = () => {
    throw new Error('the driver must not be reached once the Hard Stop has refused the write');
  };
  return {
    query: refuse,
    queryOne: refuse,
    execute: refuse,
    transaction: refuse,
  } as unknown as IDatabaseDriver;
}

/** A provider that fails the test if the pre-flight lets a pass reach the network. */
function unusableProvider(): CloudProvider {
  const refuse = () => {
    throw new Error('the provider must not be reached once the Hard Stop has refused the sync');
  };
  return {
    getServerTime: refuse,
    fetchSnapshot: refuse,
    pushSnapshot: refuse,
  } as unknown as CloudProvider;
}

const emptySnapshot: SyncSnapshot = {
  version: 1,
  generatedAt: 0,
  tables: {},
  tombstones: [],
} as unknown as SyncSnapshot;

describe('the storage Hard Stop covers the bulk write paths', () => {
  it('refuses a merge restore at the locked tier, without reaching the driver', async () => {
    setStorageWriteGate(async () => {
      throw writeSuspendedError();
    });
    await expect(restoreSnapshot(unusableDriver(), emptySnapshot)).rejects.toMatchObject({
      code: 'WRITE_SUSPENDED',
    });
  });

  it('aborts a sync pass when a write has provably run out of space (#504)', async () => {
    // The estimate this pre-flight reads is exactly the reading a padded quota, an opaque VFS
    // pool or a full device reports as healthy — so on its own it would wave the largest write
    // the app performs straight into the disk that has already refused one.
    useStorageStore.getState().reportExhaustion();

    const result = await runSync(unusableDriver(), unusableProvider());

    expect(result.status).toBe('HARD_STOP');
  });
});
