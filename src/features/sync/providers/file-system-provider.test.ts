import { describe, it, expect, vi } from 'vitest';
import { FileSystemCloudProvider } from './file-system-provider';
import { snapshotToBackupJson } from '../backup';
import type { SyncSnapshot } from '../types';

const snapshot: SyncSnapshot = {
  formatVersion: 1,
  generatedAt: 1000,
  tables: { items: [{ id: 'i1', name: 'Widget' }] },
  tombstones: [],
  gaugeHistory: [],
  itemTags: [],
  locationTags: [],
  itemRegions: [],
  itemHistory: [],
  stockDeltas: [],
};

interface FakeWritable {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort?: ReturnType<typeof vi.fn>;
}

/**
 * A directory holding one file, whose writable can be made to fail on either half of the
 * commit. `omitAbort` models a host (or an older browser) whose stream has no `abort`.
 */
function fakeDir(options: { failOn?: 'write' | 'close'; abortFails?: boolean; omitAbort?: boolean } = {}) {
  const writable: FakeWritable = {
    write: vi.fn(async () => {
      if (options.failOn === 'write') throw new Error('quota exceeded');
    }),
    close: vi.fn(async () => {
      if (options.failOn === 'close') throw new Error('quota exceeded');
    }),
  };
  if (!options.omitAbort) {
    writable.abort = vi.fn(async () => {
      if (options.abortFails) throw new Error('stream already errored');
    });
  }
  const getFileHandle = vi.fn(async () => ({
    getFile: async () => new File([], 'gubbins-sync.json'),
    createWritable: async () => writable,
  }));
  return { dir: { name: 'Backups', getFileHandle }, writable, getFileHandle };
}

describe('FileSystemCloudProvider.pushSnapshot', () => {
  it('writes the snapshot and closes the stream to commit it', async () => {
    const { dir, writable, getFileHandle } = fakeDir();

    await new FileSystemCloudProvider(dir).pushSnapshot(snapshot);

    expect(getFileHandle).toHaveBeenCalledWith('gubbins-sync.json', { create: true });
    expect(writable.write).toHaveBeenCalledWith(snapshotToBackupJson(snapshot));
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  // Issue #650: a dropped stream strands its staging file in the user's synced folder, where
  // their cloud client replicates it to every other device.
  it('aborts the stream when the write fails, and reports the failure', async () => {
    const { dir, writable } = fakeDir({ failOn: 'write' });

    await expect(new FileSystemCloudProvider(dir).pushSnapshot(snapshot)).rejects.toThrow('quota exceeded');

    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });

  // The abort is inert here — a stream whose `close()` rejected is already errored, so there is
  // nothing left to reclaim. The single release path is still what keeps the failure reported.
  it('releases the stream when the close fails, and reports the failure', async () => {
    const { dir, writable } = fakeDir({ failOn: 'close' });

    await expect(new FileSystemCloudProvider(dir).pushSnapshot(snapshot)).rejects.toThrow('quota exceeded');

    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it('still reports the write failure when the abort itself fails', async () => {
    const { dir } = fakeDir({ failOn: 'write', abortFails: true });

    await expect(new FileSystemCloudProvider(dir).pushSnapshot(snapshot)).rejects.toThrow('quota exceeded');
  });

  it('still reports the write failure on a stream with no abort', async () => {
    const { dir } = fakeDir({ failOn: 'write', omitAbort: true });

    await expect(new FileSystemCloudProvider(dir).pushSnapshot(snapshot)).rejects.toThrow('quota exceeded');
  });
});
