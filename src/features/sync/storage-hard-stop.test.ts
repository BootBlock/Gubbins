/**
 * Issue #200: the §7.6.1 Hard Stop reaches the bulk write paths, not just repository writes.
 *
 * A snapshot restore builds its own statements and hands them straight to
 * `driver.transaction(...)`, so `BaseRepository.assertWritable()` never saw it. This asserts the
 * gate now refuses such a write at the locked tier — and, importantly, that it refuses it
 * *before* the driver is touched, so nothing partial reaches a database that has no room.
 *
 * (A sync pass is covered elsewhere: `./sync-engine` aborts on a fresh estimate at the
 * *critical* threshold, before the merge begins.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setStorageWriteGate, writeSuspendedError } from '@/features/storage/write-gate';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { restoreSnapshot } from './snapshot';
import type { SyncSnapshot } from './types';

afterEach(() => setStorageWriteGate(null));

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
});
