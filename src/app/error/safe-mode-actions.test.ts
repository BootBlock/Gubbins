/**
 * The destructive raw-`.sqlite` restore (spec §3) and the guards added in issue #198: prove
 * the incoming database is sound, and secure the current one, *before* anything is overwritten.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inspectRestoreCandidate = vi.hoisted(() => vi.fn());
const disposeDatabase = vi.hoisted(() => vi.fn());
const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock('@/db/restore-candidate', () => ({ inspectRestoreCandidate }));
vi.mock('@/db/client', () => ({ disposeDatabase, getDatabaseDriver: vi.fn() }));
vi.mock('@/lib/download', () => ({ downloadBlob, fileTimestamp: () => '20260719-120000' }));
vi.mock('@/features/images/opfs-images', () => ({ removeImagesDirectory: vi.fn() }));
vi.mock('@/lib/app-shell-reset', () => ({ resetAppShell: vi.fn() }));

import {
  DamagedDatabaseError,
  RestorePointError,
  captureRestorePoint,
  isSqliteFile,
  overwriteOpfsDatabase,
  restoreRawSqlite,
  StaleJournalError,
} from './safe-mode-actions';
import { SQLITE_MAGIC } from '@/db/sqlite-header';

/** A file whose first 16 bytes are the SQLite magic — all the pre-#198 guard ever checked. */
function sqliteBytes(size = 8192): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(
    Uint8Array.from(SQLITE_MAGIC, (c) => c.charCodeAt(0)),
    0,
  );
  return bytes;
}

function sqliteFile(): File {
  return new File([sqliteBytes()], 'backup.sqlite', { type: 'application/x-sqlite3' });
}

/**
 * Where an overwrite can be made to fail. `write` and `close` are the two halves of the OPFS
 * write — real quota errors usually surface at `close()`, once the staged bytes are committed,
 * so both must be covered. `remove` is a sidecar deletion failing *after* those bytes landed.
 */
type OpfsFailure = 'write' | 'close' | 'remove';

/**
 * Install a fake OPFS root, returning what it saw in order — so a test can assert that the
 * new bytes are written before any sidecar is deleted (#203).
 *
 * `size` is the live database's byte count; `'absent'` is a device with no database yet, and
 * `'unreadable'` is one whose database is there but cannot be read.
 */
function mockOpfs(size: number | 'absent' | 'unreadable', options: { failAt?: OpfsFailure } = {}): string[] {
  const events: string[] = [];
  const failWith = (message: string, name: string) => {
    throw new DOMException(message, name);
  };
  const getFileHandle = vi.fn(async (_name: string, opts?: { create?: boolean }) => {
    // Only the read path can be missing/unreadable; the overwrite always opens with `create`.
    if (!opts?.create) {
      if (size === 'absent') throw new DOMException('No such file.', 'NotFoundError');
      if (size === 'unreadable') throw new DOMException('Access denied.', 'NoModificationAllowedError');
    }
    return {
      getFile: async () => new File([new Uint8Array(typeof size === 'number' ? size : 0)], 'gubbins.sqlite3'),
      createWritable: async () => ({
        write: vi.fn(async () => {
          if (options.failAt === 'write') failWith('Quota exceeded.', 'QuotaExceededError');
          events.push('write');
        }),
        close: vi.fn(async () => {
          if (options.failAt === 'close') failWith('Quota exceeded.', 'QuotaExceededError');
          events.push('close');
        }),
        abort: vi.fn(async () => events.push('abort')),
      }),
    };
  });
  const removeEntry = vi.fn(async (name: string) => {
    // A sidecar that isn't there is the normal case after a clean shutdown, not a failure.
    if (options.failAt === 'remove') failWith('Access denied.', 'NoModificationAllowedError');
    if (name.endsWith('-shm')) failWith('No such file.', 'NotFoundError');
    events.push(`remove:${name}`);
  });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getFileHandle, removeEntry }) } });
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // `location.reload` is the last line of a successful restore; jsdom refuses the real one.
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  inspectRestoreCandidate.mockResolvedValue({ status: 'ok', problems: [] });
  mockOpfs(4096);
});

describe('captureRestorePoint (issue #198)', () => {
  it('downloads the current database before it can be overwritten', async () => {
    expect(await captureRestorePoint()).toBe(true);
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('gubbins-restore-point-'),
      expect.any(Blob),
    );
  });

  it('reports nothing captured when there is no database yet — which is not a failure', async () => {
    mockOpfs('absent');
    expect(await captureRestorePoint()).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('reports nothing captured for an empty database file', async () => {
    mockOpfs(0);
    expect(await captureRestorePoint()).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('raises a database that is there but unreadable, rather than reporting nothing to save', async () => {
    // The dangerous confusion: treating "I could not read it" as "there was nothing there"
    // would let the restore overwrite real data with no copy behind it.
    mockOpfs('unreadable');
    await expect(captureRestorePoint()).rejects.toThrow(/access denied/i);
  });
});

describe('restoreRawSqlite (issue #198)', () => {
  it('refuses a damaged database and touches nothing', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await expect(restoreRawSqlite(sqliteFile())).rejects.toBeInstanceOf(DamagedDatabaseError);

    // The live database is still there — and the user was not made to sit through a
    // restore-point download for a file that was never going to be used.
    expect(disposeDatabase).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('carries the specific problems so the user can judge the override', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await expect(restoreRawSqlite(sqliteFile())).rejects.toMatchObject({
      problems: ['Page 4 is corrupt.'],
    });
  });

  it('proceeds when forced, but still saves a restore point first', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await restoreRawSqlite(sqliteFile(), { force: true });

    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(disposeDatabase).toHaveBeenCalledOnce();
  });

  it('does not re-scan the file on a forced retry — the user has already seen the verdict', async () => {
    await restoreRawSqlite(sqliteFile(), { force: true });
    expect(inspectRestoreCandidate).not.toHaveBeenCalled();
  });

  it('proceeds when the deep check could not run — an unverified file is not a blocked one', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'unverified', problems: [] });

    await restoreRawSqlite(sqliteFile());

    expect(disposeDatabase).toHaveBeenCalledOnce();
  });

  it('saves the restore point before disposing the worker or overwriting', async () => {
    const order: string[] = [];
    downloadBlob.mockImplementation(() => order.push('restore-point'));
    disposeDatabase.mockImplementation(() => order.push('dispose'));

    await restoreRawSqlite(sqliteFile());

    expect(order).toEqual(['restore-point', 'dispose']);
  });

  it('cancels the restore when the current database cannot be saved', async () => {
    downloadBlob.mockImplementation(() => {
      throw new Error('Download blocked.');
    });

    await expect(restoreRawSqlite(sqliteFile())).rejects.toBeInstanceOf(RestorePointError);
    expect(disposeDatabase).not.toHaveBeenCalled();
  });

  it('still rejects a file that is not a SQLite database at all', async () => {
    const json = new File(['{"formatVersion":1}'], 'backup.json');
    await expect(restoreRawSqlite(json)).rejects.toThrow(/not a SQLite database/);
    expect(inspectRestoreCandidate).not.toHaveBeenCalled();
  });
});

describe('overwriteOpfsDatabase (issue #203)', () => {
  it('writes and commits the new bytes before it clears the journal sidecars', async () => {
    // A hot rollback journal is the only thing that can repair the current database, so it
    // must outlive every step that could still fail. The `-shm` removal is absent here, which
    // is the ordinary case after a clean shutdown rather than a failure.
    const events = mockOpfs(4096);

    await overwriteOpfsDatabase(sqliteBytes());

    expect(events).toEqual([
      'write',
      'close',
      'remove:gubbins.sqlite3-journal',
      'remove:gubbins.sqlite3-wal',
    ]);
  });

  it.each(['write', 'close'] as const)(
    'leaves the sidecars intact and aborts when the new bytes fail at %s()',
    async (failAt) => {
      // `close()` matters most: OPFS stages the write, so a quota error normally lands there.
      const events = mockOpfs(4096, { failAt });

      await expect(overwriteOpfsDatabase(sqliteBytes())).rejects.toThrow(/quota/i);

      // Nothing was deleted: the database is un-updated, not destroyed.
      expect(events.filter((event) => event.startsWith('remove:'))).toEqual([]);
      expect(events).toContain('abort');
    },
  );

  it('raises a sidecar removal that fails for a reason other than absence', async () => {
    // The new database is on disk but an old journal survives beside it — replaying that over
    // the fresh file is exactly the corruption the caller must not reload into.
    mockOpfs(4096, { failAt: 'remove' });

    await expect(overwriteOpfsDatabase(sqliteBytes())).rejects.toBeInstanceOf(StaleJournalError);
  });

  it('names the sidecar it could not remove, and keeps the cause', async () => {
    mockOpfs(4096, { failAt: 'remove' });

    await expect(overwriteOpfsDatabase(sqliteBytes())).rejects.toMatchObject({
      sidecar: 'gubbins.sqlite3-journal',
      cause: expect.objectContaining({ name: 'NoModificationAllowedError' }),
    });
  });
});

describe('isSqliteFile (§3 raw restore guard)', () => {
  it('accepts a buffer beginning with the SQLite 3 magic header', () => {
    expect(isSqliteFile(sqliteBytes(200))).toBe(true);
  });

  it('rejects a JSON file (wrong header)', () => {
    expect(isSqliteFile(new TextEncoder().encode('{"formatVersion":1}'))).toBe(false);
  });

  it('rejects a truncated file shorter than the header', () => {
    expect(isSqliteFile(new Uint8Array([0x53, 0x51, 0x4c]))).toBe(false);
  });
});
