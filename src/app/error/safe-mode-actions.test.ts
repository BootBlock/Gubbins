/**
 * The destructive raw-`.sqlite` restore (spec §3) and the guards added in issues #198 and #501:
 * prove the incoming database is sound *and* that this build can actually open it, and secure the
 * current one, before anything is overwritten.
 *
 * Also the fallback-VFS half of issue #255: under `opfs-sahpool` the database is *not* a file
 * any directory handle can reach, so every one of these actions has to notice that and go
 * through the worker instead — a rescue that silently wrote beside the real database would be
 * worse than one that refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inspectRestoreCandidate = vi.hoisted(() => vi.fn());
const disposeDatabase = vi.hoisted(() => vi.fn());
const downloadBlob = vi.hoisted(() => vi.fn());
const readDatabaseFile = vi.hoisted(() => vi.fn());
const writeDatabaseFile = vi.hoisted(() => vi.fn());
const wipeDatabaseFiles = vi.hoisted(() => vi.fn());
const exportBinary = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const getRescueDatabaseDriver = vi.hoisted(() =>
  vi.fn(async () => ({ readDatabaseFile, writeDatabaseFile, wipeDatabaseFiles, exportBinary, query })),
);

vi.mock('@/db/restore-candidate', () => ({ inspectRestoreCandidate }));
vi.mock('@/db/client', () => ({ disposeDatabase, getRescueDatabaseDriver }));
vi.mock('@/lib/download', () => ({ downloadBlob, fileTimestamp: () => '20260719-120000' }));
vi.mock('@/features/images/opfs-images', () => ({ removeImagesDirectory: vi.fn() }));
vi.mock('@/lib/app-shell-reset', () => ({ resetAppShell: vi.fn() }));

import {
  DamagedDatabaseError,
  IncompatibleDatabaseError,
  RestorePointError,
  RestorePointNotSavedError,
  captureRestorePoint,
  downloadJsonDump,
  downloadRawSqlite,
  hardResetLocalData,
  isSqliteFile,
  overwriteDatabaseFile,
  restoreRawSqlite,
  StaleJournalError,
} from './safe-mode-actions';
import { setStorageOutcomeObserver } from '@/features/storage/exhaustion';
import { SAHPOOL_DIRECTORY } from '@/db/db-storage';
import { readDbPresence, writeDbPresence } from '@/db/db-presence';
import { SQLITE_MAGIC } from '@/db/sqlite-header';
import type { SafeSave } from '@/lib/save-file';

const RESTORE_POINT_NAME = 'gubbins-restore-point-20260719-120000.sqlite';

/**
 * The restore point's destination (issue #502). Defaults to the browsers that *cannot* report a
 * save — the anchor download, plus the acknowledgement that stands in for one — so these tests
 * keep asserting on `downloadBlob` exactly as they did before the copy had to prove itself.
 */
function anchorSave(confirm: () => Promise<boolean> = async () => true): SafeSave {
  return {
    saver: {
      filename: RESTORE_POINT_NAME,
      save: async (blob: Blob) => {
        downloadBlob(RESTORE_POINT_NAME, blob);
        return 'unverified';
      },
    },
    confirmUnverified: confirm,
  };
}

/** The File System Access route: the write itself reports, so nothing is asked of the user. */
function verifiedSave(onSave: (blob: Blob) => void = () => {}): SafeSave {
  return {
    saver: {
      filename: RESTORE_POINT_NAME,
      save: async (blob: Blob) => {
        onSave(blob);
        return 'saved';
      },
    },
    confirmUnverified: async () => {
      throw new Error('A verified save must never ask the user.');
    },
  };
}

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
function mockOpfs(
  size: number | 'absent' | 'unreadable',
  options: { failAt?: OpfsFailure; sahPool?: boolean } = {},
): string[] {
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
  // The fallback VFS's store is a *directory*, and its presence is what tells the main thread
  // the database is somewhere only the worker can reach (issue #255).
  const getDirectoryHandle = vi.fn(async (name: string) => {
    if (!options.sahPool || name !== SAHPOOL_DIRECTORY) {
      failWith('No such directory.', 'NotFoundError');
    }
    return {};
  });
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ getFileHandle, getDirectoryHandle, removeEntry }) },
  });
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // `location.reload` is the last line of a successful restore; jsdom refuses the real one.
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  // `clearAllMocks` forgets the *calls* but keeps the implementations, and several tests here
  // install one to record ordering or force a failure — reset the two that would otherwise leak
  // into the next test (the driver mock keeps its own, so it is deliberately not reset).
  downloadBlob.mockReset();
  disposeDatabase.mockReset();
  inspectRestoreCandidate.mockResolvedValue({ status: 'ok', problems: [] });
  writeDatabaseFile.mockResolvedValue({ staleSidecar: null });
  readDatabaseFile.mockResolvedValue(null);
  wipeDatabaseFiles.mockResolvedValue(undefined);
  exportBinary.mockResolvedValue(sqliteBytes());
  query.mockResolvedValue([]);
  // The data-loss marker (issue #505) is real `localStorage`, which these tests both read and
  // write — start each from a device that has recorded nothing.
  localStorage.clear();
  mockOpfs(4096);
});

describe('captureRestorePoint (issue #198)', () => {
  it('saves the current database before it can be overwritten', async () => {
    expect(await captureRestorePoint(anchorSave())).toBe(true);
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('gubbins-restore-point-'),
      expect.any(Blob),
    );
  });

  it('reports nothing captured when there is no database yet — which is not a failure', async () => {
    mockOpfs('absent');
    expect(await captureRestorePoint(anchorSave())).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('reports nothing captured for an empty database file', async () => {
    mockOpfs(0);
    expect(await captureRestorePoint(anchorSave())).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('raises a database that is there but unreadable, rather than reporting nothing to save', async () => {
    // The dangerous confusion: treating "I could not read it" as "there was nothing there"
    // would let the restore overwrite real data with no copy behind it.
    mockOpfs('unreadable');
    await expect(captureRestorePoint(anchorSave())).rejects.toThrow(/access denied/i);
  });
});

describe('captureRestorePoint — the copy has to prove it landed (issue #502)', () => {
  it('refuses when the user says the file never arrived', async () => {
    // The bug this closes: `<a download>` cannot report, so the old code returned `true`
    // unconditionally and the caller overwrote the database on the strength of it.
    await expect(captureRestorePoint(anchorSave(async () => false))).rejects.toBeInstanceOf(
      RestorePointNotSavedError,
    );
  });

  it('does not ask when the save reported itself', async () => {
    // `verifiedSave` throws if its acknowledgement is reached — a File System Access write that
    // closed cleanly is the answer, and asking again would be noise on every desktop restore.
    const written: Blob[] = [];
    expect(await captureRestorePoint(verifiedSave((blob) => written.push(blob)))).toBe(true);
    expect(written).toHaveLength(1);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('restoreRawSqlite (issue #198)', () => {
  it('refuses a damaged database and touches nothing', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await expect(restoreRawSqlite(sqliteFile(), { save: anchorSave() })).rejects.toBeInstanceOf(
      DamagedDatabaseError,
    );

    // The live database is still there — and the user was not made to sit through a
    // restore-point download for a file that was never going to be used.
    expect(disposeDatabase).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('carries the specific problems so the user can judge the override', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await expect(restoreRawSqlite(sqliteFile(), { save: anchorSave() })).rejects.toMatchObject({
      problems: ['Page 4 is corrupt.'],
    });
  });

  it('proceeds when forced, but still saves a restore point first', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'damaged', problems: ['Page 4 is corrupt.'] });

    await restoreRawSqlite(sqliteFile(), { force: true, save: anchorSave() });

    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(disposeDatabase).toHaveBeenCalledOnce();
  });

  it('does not re-scan the file on a forced retry — the user has already seen the verdict', async () => {
    await restoreRawSqlite(sqliteFile(), { force: true, save: anchorSave() });
    expect(inspectRestoreCandidate).not.toHaveBeenCalled();
  });

  it('proceeds when the deep check could not run — an unverified file is not a blocked one', async () => {
    inspectRestoreCandidate.mockResolvedValue({ status: 'unverified', problems: [] });

    await restoreRawSqlite(sqliteFile(), { save: anchorSave() });

    expect(disposeDatabase).toHaveBeenCalledOnce();
  });

  it('saves the restore point before disposing the worker or overwriting', async () => {
    const order: string[] = [];
    downloadBlob.mockImplementation(() => order.push('restore-point'));
    disposeDatabase.mockImplementation(() => order.push('dispose'));

    await restoreRawSqlite(sqliteFile(), { save: anchorSave() });

    expect(order).toEqual(['restore-point', 'dispose']);
  });

  it('cancels the restore when the current database cannot be saved', async () => {
    downloadBlob.mockImplementation(() => {
      throw new Error('Download blocked.');
    });

    await expect(restoreRawSqlite(sqliteFile(), { save: anchorSave() })).rejects.toBeInstanceOf(
      RestorePointError,
    );
    expect(disposeDatabase).not.toHaveBeenCalled();
  });

  it('cancels the restore when the restore point is not confirmed as saved (issue #502)', async () => {
    // The overwrite is irreversible and this copy is the only undo, so an unconfirmed one is
    // worth exactly as much as a missing one: stop, before anything is written.
    await expect(
      restoreRawSqlite(sqliteFile(), { save: anchorSave(async () => false) }),
    ).rejects.toBeInstanceOf(RestorePointNotSavedError);

    expect(disposeDatabase).not.toHaveBeenCalled();
  });

  it('still rejects a file that is not a SQLite database at all', async () => {
    const json = new File(['{"formatVersion":1}'], 'backup.json');
    await expect(restoreRawSqlite(json, { save: anchorSave() })).rejects.toThrow(/not a SQLite database/);
    expect(inspectRestoreCandidate).not.toHaveBeenCalled();
  });
});

describe('restoreRawSqlite — schema baseline (issue #501)', () => {
  it('refuses an intact database built by another version and touches nothing', async () => {
    // The bug this closes: the file passes every structural check, so the old code overwrote a
    // healthy database with one the next boot would refuse outright.
    inspectRestoreCandidate.mockResolvedValue({ status: 'incompatible', problems: [] });

    await expect(restoreRawSqlite(sqliteFile(), { save: anchorSave() })).rejects.toBeInstanceOf(
      IncompatibleDatabaseError,
    );

    expect(disposeDatabase).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('proceeds when forced, but still saves a restore point first', async () => {
    // A boot refusal is survivable, so the override stays available — the restore point is what
    // makes it so, and it must still be taken.
    inspectRestoreCandidate.mockResolvedValue({ status: 'incompatible', problems: [] });

    await restoreRawSqlite(sqliteFile(), { force: true, save: anchorSave() });

    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(disposeDatabase).toHaveBeenCalledOnce();
  });
});

describe('overwriteDatabaseFile (issue #203)', () => {
  it('writes and commits the new bytes before it clears the journal sidecars', async () => {
    // A hot rollback journal is the only thing that can repair the current database, so it
    // must outlive every step that could still fail. The `-shm` removal is absent here, which
    // is the ordinary case after a clean shutdown rather than a failure.
    const events = mockOpfs(4096);

    await overwriteDatabaseFile(sqliteBytes());

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

      await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toThrow(/quota/i);

      // Nothing was deleted: the database is un-updated, not destroyed.
      expect(events.filter((event) => event.startsWith('remove:'))).toEqual([]);
      expect(events).toContain('abort');
    },
  );

  it('reports running out of room to the storage tier (#504)', async () => {
    // This write never reaches the database worker, so nothing else can observe it — and it backs
    // the ordinary backup restore as well as the crash screen. Left unreported, the tier would
    // keep believing the estimate that said there was room for it.
    const onExhausted = vi.fn();
    setStorageOutcomeObserver({ onExhausted, onWriteSucceeded: vi.fn() });
    try {
      mockOpfs(4096, { failAt: 'close' });
      await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toThrow(/quota/i);
      expect(onExhausted).toHaveBeenCalledTimes(1);
    } finally {
      setStorageOutcomeObserver(null);
    }
  });

  it('raises a sidecar removal that fails for a reason other than absence', async () => {
    // The new database is on disk but an old journal survives beside it — replaying that over
    // the fresh file is exactly the corruption the caller must not reload into.
    mockOpfs(4096, { failAt: 'remove' });

    await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toBeInstanceOf(StaleJournalError);
  });

  it('names the sidecar it could not remove, and keeps the cause', async () => {
    mockOpfs(4096, { failAt: 'remove' });

    await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toMatchObject({
      sidecar: 'gubbins.sqlite3-journal',
      cause: expect.objectContaining({ name: 'NoModificationAllowedError' }),
    });
  });

  /**
   * A restore is the answer to "your data was cleared by the browser" (issue #505), and that
   * notice is re-raised on every boot until it is answered. Leaving it pending would greet the
   * user's reload into their freshly-restored inventory with a screen saying it is gone.
   */
  it('settles a pending data-loss notice once the restored bytes have committed', async () => {
    mockOpfs(4096);
    writeDbPresence({
      version: 1,
      lastSeenAt: 1,
      lastKnownItems: 42,
      unacknowledgedLoss: { detectedAt: 2, lastSeenAt: 1, lastKnownItems: 42 },
    });

    await overwriteDatabaseFile(sqliteBytes());

    expect(readDbPresence()?.unacknowledgedLoss).toBeNull();
  });

  it('settles it even when a stale journal survives — the restore still landed', async () => {
    mockOpfs(4096, { failAt: 'remove' });
    writeDbPresence({
      version: 1,
      lastSeenAt: 1,
      lastKnownItems: 42,
      unacknowledgedLoss: { detectedAt: 2, lastSeenAt: 1, lastKnownItems: 42 },
    });

    await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toBeInstanceOf(StaleJournalError);

    expect(readDbPresence()?.unacknowledgedLoss).toBeNull();
  });

  it('leaves it pending when the write failed — nothing has answered the loss', async () => {
    mockOpfs(4096, { failAt: 'close' });
    const loss = { detectedAt: 2, lastSeenAt: 1, lastKnownItems: 42 };
    writeDbPresence({ version: 1, lastSeenAt: 1, lastKnownItems: 42, unacknowledgedLoss: loss });

    await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toThrow(/quota/i);

    expect(readDbPresence()?.unacknowledgedLoss).toEqual(loss);
  });
});

describe('the opfs-sahpool fallback VFS (issue #255)', () => {
  it('captures the restore point through the worker, since no directory handle can reach it', async () => {
    mockOpfs('absent', { sahPool: true });
    readDatabaseFile.mockResolvedValue(sqliteBytes());

    expect(await captureRestorePoint(anchorSave())).toBe(true);
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('gubbins-restore-point-'),
      expect.any(Blob),
    );
  });

  it('reports nothing captured when the pool holds no database', async () => {
    mockOpfs('absent', { sahPool: true });
    readDatabaseFile.mockResolvedValue(null);

    expect(await captureRestorePoint(anchorSave())).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('writes a restore through the worker, and only then releases it', async () => {
    // The order is the opposite of the plain-OPFS one: dispose first and the pool's own bytes
    // would be unreachable, so the restore would land in a file nothing ever opens.
    const order: string[] = [];
    mockOpfs('absent', { sahPool: true });
    writeDatabaseFile.mockImplementation(async () => {
      order.push('write');
      return { staleSidecar: null };
    });
    disposeDatabase.mockImplementation(() => order.push('dispose'));

    await overwriteDatabaseFile(sqliteBytes());

    expect(order).toEqual(['write', 'dispose']);
  });

  it('still raises a sidecar the worker could not clear', async () => {
    mockOpfs('absent', { sahPool: true });
    writeDatabaseFile.mockResolvedValue({ staleSidecar: 'gubbins.sqlite3-journal' });

    await expect(overwriteDatabaseFile(sqliteBytes())).rejects.toBeInstanceOf(StaleJournalError);
  });

  it('writes through the worker on a fresh install too — only it knows which VFS will boot', async () => {
    mockOpfs('absent');

    await overwriteDatabaseFile(sqliteBytes());

    expect(writeDatabaseFile).toHaveBeenCalledOnce();
  });

  it('has the VFS blank its own files before the purge terminates the worker', async () => {
    // A `removeEntry` on the pool directory can fail outright while the worker still holds a
    // sync access handle on every file in it — which would leave "erase everything" not erasing.
    const order: string[] = [];
    mockOpfs('absent', { sahPool: true });
    wipeDatabaseFiles.mockImplementation(async () => void order.push('wipe'));
    disposeDatabase.mockImplementation(() => order.push('dispose'));

    await hardResetLocalData();

    expect(order).toEqual(['wipe', 'dispose']);
  });

  it('still purges when the worker is too far gone to answer', async () => {
    const events = mockOpfs('absent', { sahPool: true });
    wipeDatabaseFiles.mockRejectedValue(new Error('The database driver was disposed.'));

    await hardResetLocalData();

    expect(events).toContain(`remove:${SAHPOOL_DIRECTORY}`);
  });
});

describe('the extraction rescues after a worker crash (issue #503)', () => {
  // These are the "get your data out" half of the screen. They used to take the driver as-is,
  // so a crashed worker — one of the main reasons a user is on this screen at all — failed
  // every one of them while the irreversible purge below replaced the worker and succeeded.

  it('downloads the .sqlite copy through a driver whose dead worker has been replaced', async () => {
    await downloadRawSqlite();

    expect(getRescueDatabaseDriver).toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledWith(expect.stringContaining('.sqlite'), expect.any(Blob));
  });

  it('exports the JSON dump through a driver whose dead worker has been replaced', async () => {
    await downloadJsonDump();

    expect(getRescueDatabaseDriver).toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('gubbins-safe-export-'),
      expect.any(Blob),
    );
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
