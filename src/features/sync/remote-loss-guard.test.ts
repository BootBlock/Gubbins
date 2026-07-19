/**
 * Issue #196: a remote that cannot be read must never be mistaken for an empty one.
 *
 * The failure this guards is silent and total: `runSync` answers a `null` snapshot by
 * publishing the local database over the remote and reporting `PUBLISHED`, so any provider
 * that returns `null` for a *failed* read discards every record that only lives on the other
 * devices — and says it worked. These tests pin both halves of the fix: providers raise
 * rather than return `null`, and the engine refuses a first publish on a device that has
 * demonstrably synced before.
 */
import { describe, it, expect } from 'vitest';
import { createMemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { FileSystemCloudProvider } from './providers/file-system-provider';
import { GoogleDriveCloudProvider } from './providers/google-drive-provider';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync } from './sync-engine';
import { SyncRemoteMissingError, SyncRemoteUnreadableError } from './sync-errors';
import { snapshotToBackupJson } from './backup';
import type { CloudProvider } from './provider';
import type { SyncSnapshot } from './types';

const NO_QUOTA = { skipQuotaCheck: true } as const;

const snapshot: SyncSnapshot = {
  formatVersion: 1,
  generatedAt: 1000,
  tables: { items: [{ id: 'remote-only', name: 'Only on the other device' }] },
  tombstones: [],
  gaugeHistory: [],
  itemTags: [],
  locationTags: [],
  itemRegions: [],
  itemHistory: [],
};

async function makeDriver() {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return driver;
}

/** A `DOMException`-shaped rejection, as the File System Access API raises. */
function fsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/**
 * A directory double whose single file either reads back `text`, or fails the read with
 * `failure` (the shape of a cloud placeholder that hasn't materialised, or a locked file).
 */
function fakeDir(options: { text?: string; getFileHandleError?: Error; readError?: Error }) {
  return {
    name: 'Sync',
    getFileHandle: async () => {
      if (options.getFileHandleError) throw options.getFileHandleError;
      return {
        getFile: async () => {
          if (options.readError) throw options.readError;
          return { text: async () => options.text ?? '' } as unknown as File;
        },
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      };
    },
  } as unknown as ConstructorParameters<typeof FileSystemCloudProvider>[0];
}

describe('FileSystemCloudProvider.fetchSnapshot distinguishes "empty" from "unreadable"', () => {
  it('returns null only when the file is genuinely absent', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ getFileHandleError: fsError('NotFoundError') }));
    expect(await provider.fetchSnapshot()).toBeNull();
  });

  it('raises when the file exists but cannot be read', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ readError: fsError('NotReadableError') }));
    await expect(provider.fetchSnapshot()).rejects.toBeInstanceOf(SyncRemoteUnreadableError);
  });

  it('raises when opening the file is refused (permission), rather than claiming an empty remote', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ getFileHandleError: fsError('NotAllowedError') }));
    await expect(provider.fetchSnapshot()).rejects.toBeInstanceOf(SyncRemoteUnreadableError);
  });

  it('raises on a zero-byte file — what an interrupted push leaves behind', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ text: '   ' }));
    await expect(provider.fetchSnapshot()).rejects.toBeInstanceOf(SyncRemoteUnreadableError);
  });

  it('raises on a half-written / corrupt file rather than publishing over it', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ text: '{"formatVersion":1,"tabl' }));
    await expect(provider.fetchSnapshot()).rejects.toBeInstanceOf(SyncRemoteUnreadableError);
  });

  it('still reads a good snapshot', async () => {
    const provider = new FileSystemCloudProvider(fakeDir({ text: snapshotToBackupJson(snapshot) }));
    expect((await provider.fetchSnapshot())?.tables.items?.[0]?.id).toBe('remote-only');
  });
});

describe('GoogleDriveCloudProvider.fetchSnapshot', () => {
  /** A Drive whose `files` query finds one file, which reads back as `content`. */
  function drive(content: string) {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('alt=media')) return new Response(content, { status: 200 });
      return new Response(JSON.stringify({ files: [{ id: 'file-1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    return { fetch: fetchImpl as unknown as typeof fetch, token: async () => 'ya29.TEST' };
  }

  it('raises when the file exists but reads back empty', async () => {
    await expect(new GoogleDriveCloudProvider(drive('  ')).fetchSnapshot()).rejects.toBeInstanceOf(
      SyncRemoteUnreadableError,
    );
  });

  it('raises when the file exists but is not a readable snapshot', async () => {
    await expect(new GoogleDriveCloudProvider(drive('{oops')).fetchSnapshot()).rejects.toBeInstanceOf(
      SyncRemoteUnreadableError,
    );
  });
});

describe('runSync refuses to republish over a remote that has gone missing', () => {
  it('publishes normally on a device that has never synced', async () => {
    const driver = await makeDriver();
    const outcome = await runSync(driver, new MemoryCloudProvider(), NO_QUOTA);
    expect(outcome.status).toBe('PUBLISHED');
    await driver.close();
  });

  it('throws instead of wiping the shared copy once the device has synced before', async () => {
    const driver = await makeDriver();
    const items = new ItemRepository(driver);
    await items.create({ name: 'Local widget', locationId: UNASSIGNED_LOCATION_ID });

    // A provider that syncs once, then loses sight of the remote (a folder that has not
    // re-populated, a trashed Drive file, a reconnect to the wrong account).
    const backing = new MemoryCloudProvider();
    let blind = false;
    const flaky: CloudProvider = {
      id: 'flaky',
      label: 'flaky',
      getServerTime: () => backing.getServerTime(),
      fetchSnapshot: async () => (blind ? null : backing.fetchSnapshot()),
      pushSnapshot: (s) => backing.pushSnapshot(s),
    };

    expect((await runSync(driver, flaky, NO_QUOTA)).status).toBe('PUBLISHED');
    const published = backing.peek();
    expect(published).not.toBeNull();

    blind = true;
    await expect(runSync(driver, flaky, NO_QUOTA)).rejects.toBeInstanceOf(SyncRemoteMissingError);
    // The crux: the shared snapshot is untouched, not replaced by this device's state.
    expect(backing.peek()).toBe(published);
    await driver.close();
  });

  it('republishes when the user explicitly accepts the loss (allowRemoteReset)', async () => {
    const driver = await makeDriver();
    const backing = new MemoryCloudProvider();
    let blind = false;
    const flaky: CloudProvider = {
      id: 'flaky',
      label: 'flaky',
      getServerTime: () => backing.getServerTime(),
      fetchSnapshot: async () => (blind ? null : backing.fetchSnapshot()),
      pushSnapshot: (s) => backing.pushSnapshot(s),
    };

    await runSync(driver, flaky, NO_QUOTA);
    blind = true;
    const outcome = await runSync(driver, flaky, { ...NO_QUOTA, allowRemoteReset: true });
    expect(outcome.status).toBe('PUBLISHED');
    await driver.close();
  });

  it('propagates an unreadable remote rather than treating it as a first publish', async () => {
    const driver = await makeDriver();
    const unreadable: CloudProvider = {
      id: 'unreadable',
      label: 'unreadable',
      getServerTime: async () => null,
      fetchSnapshot: async () => {
        throw new SyncRemoteUnreadableError('nope');
      },
      pushSnapshot: async () => {
        throw new Error('must not push over an unreadable remote');
      },
    };
    await expect(runSync(driver, unreadable, NO_QUOTA)).rejects.toBeInstanceOf(SyncRemoteUnreadableError);
    await driver.close();
  });
});
