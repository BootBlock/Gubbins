/**
 * The rescue backup offered by the crash / boot-failure screens (issue #197).
 *
 * Its job is to be the one artefact those screens hand out that can actually be restored
 * afterwards, so what matters here is that it survives a database this build cannot open,
 * says what it had to leave behind, and does not claim a schema baseline it does not have.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackup, createRescueBackup } from './build-backup';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { UnreadableDatabaseError } from '@/features/sync/snapshot';
import {
  DEFAULT_BACKUP_SELECTION,
  MANIFEST_ENTRY,
  SNAPSHOT_ENTRY,
  type BackupManifest,
} from './backup-format';
import { BASELINE_REVISION, BASELINE_REVISION_KEY } from '@/db/migrations';
import type { IDatabaseDriver, SqlParams, SqlRow } from '@/db/rpc/driver';
import { pageOf } from '@/test/drivers/keyset-page';
import { crashedDriver } from '@/test/drivers/crashed-driver';

const mockGetDriver = vi.fn<() => IDatabaseDriver>();
/**
 * The two ways to reach the driver, kept apart so a test can assert *which* one the rescue took
 * (issue #503): only `getRescueDatabaseDriver` replaces a worker that has already crashed.
 */
const getDatabaseDriver = vi.fn(() => mockGetDriver());
const getRescueDatabaseDriver = vi.fn(async () => mockGetDriver());
vi.mock('@/db/client', () => ({
  getDatabaseDriver: () => getDatabaseDriver(),
  getRescueDatabaseDriver: () => getRescueDatabaseDriver(),
  disposeDatabase: vi.fn(),
}));
vi.mock('@/features/images/opfs-images', () => ({ readAllImages: vi.fn(async () => []) }));

const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlob(name, blob),
  fileTimestamp: () => '20260101-000000',
}));

/** A driver over a fixed table map; every other table raises SQLite's "no such table". */
function fakeDriver(readable: Record<string, SqlRow[]>): IDatabaseDriver {
  const query = async (sql: string, params?: SqlParams): Promise<SqlRow[]> => {
    const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1] ?? '';
    const rows = readable[table];
    if (!rows) throw new Error(`no such table: ${table}`);
    return pageOf(rows, params);
  };
  return {
    query: query as IDatabaseDriver['query'],
    queryOne: (async (sql, params) => (await query(sql, params))[0]) as IDatabaseDriver['queryOne'],
    exportBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
    execute: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  } as unknown as IDatabaseDriver;
}

/** Stand-in for the off-thread zipper: echoes the entry maps back as a real zip payload. */
class FakeZipWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(request: { files: Record<string, string>; assets: Record<string, Uint8Array> }) {
    lastZipRequest = request;
    this.onmessage?.({ data: { zip: new Uint8Array([0]) } } as MessageEvent);
  }
  terminate() {}
}
let lastZipRequest: { files: Record<string, string>; assets: Record<string, Uint8Array> } | null = null;

/** The manifest the backup would have written, read back out of the zip request. */
function writtenManifest(): BackupManifest {
  return JSON.parse(lastZipRequest!.files[MANIFEST_ENTRY]!) as BackupManifest;
}

beforeEach(() => {
  lastZipRequest = null;
  downloadBlob.mockClear();
  getDatabaseDriver.mockClear();
  getRescueDatabaseDriver.mockClear();
  vi.stubGlobal('Worker', FakeZipWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createRescueBackup (issue #197)', () => {
  const items: SqlRow[] = [{ id: 'i1', name: 'Widget', is_active: 1 }];

  it('produces a restorable backup from a database this build cannot open', async () => {
    mockGetDriver.mockReturnValue(fakeDriver({ items }));

    const result = await createRescueBackup();

    // The portable snapshot — the part a merge restore reads — carries the rows.
    const snapshot = JSON.parse(lastZipRequest!.files[SNAPSHOT_ENTRY]!) as {
      tables: Record<string, SqlRow[]>;
    };
    expect(snapshot.tables.items).toEqual(items);
    expect(result.manifest.counts.items).toBe(1);
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.stringContaining('gubbins-rescue-backup'),
      expect.any(Blob),
    );
  });

  it('names the parts it could not read rather than reporting a complete backup', async () => {
    mockGetDriver.mockReturnValue(fakeDriver({ items }));

    const result = await createRescueBackup();

    expect(result.skipped).toContain('categories');
    expect(result.skipped).toContain('tombstones');
  });

  it('never stamps this build’s baseline on a database that was not built from it', async () => {
    // No `app_meta`, so the database's own fingerprint is unreadable. Claiming the current
    // baseline would let a later Replace restore write this database back and reproduce the
    // very boot failure the backup exists to escape.
    mockGetDriver.mockReturnValue(fakeDriver({ items }));

    await createRescueBackup();

    expect(writtenManifest().baselineRevision).not.toBe(BASELINE_REVISION);
  });

  it('carries the baseline the database actually records', async () => {
    mockGetDriver.mockReturnValue(
      fakeDriver({ items, app_meta: [{ key: BASELINE_REVISION_KEY, value: 'abc123' }] }),
    );

    await createRescueBackup();

    expect(writtenManifest().baselineRevision).toBe('abc123');
  });
});

describe('createRescueBackup against a crashed worker (issue #503)', () => {
  it('takes the driver that replaces a dead worker, never the latched one', async () => {
    mockGetDriver.mockReturnValue(fakeDriver({ items: [{ id: 'i1', name: 'Widget', is_active: 1 }] }));

    await createRescueBackup();

    expect(getRescueDatabaseDriver).toHaveBeenCalled();
    expect(getDatabaseDriver).not.toHaveBeenCalled();
  });

  it('fails instead of reporting a saved backup over an empty file', async () => {
    // The failure this exists to prevent: a "Saved …" summary sends the user on to the purge
    // the same screen recommends, carrying a zip with none of their data in it.
    mockGetDriver.mockReturnValue(crashedDriver());

    await expect(createRescueBackup()).rejects.toBeInstanceOf(UnreadableDatabaseError);
  });

  it('downloads nothing when there was nothing to put in the file', async () => {
    mockGetDriver.mockReturnValue(crashedDriver());

    await expect(createRescueBackup()).rejects.toThrow();

    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('createBackup is inside the permission boundary (issue #519)', () => {
  const items: SqlRow[] = [{ id: 'i1', name: 'Widget', is_active: 1 }];

  afterEach(() => {
    useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
  });

  /** A Viewer: reads the app, holds no backup key. */
  function signInWithoutBackupRead(): void {
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['items:read']) }, 'user-1');
  }

  it('refuses an ordinary backup to a session without `backup:read`', async () => {
    mockGetDriver.mockReturnValue(fakeDriver({ items }));
    signInWithoutBackupRead();

    await expect(createBackup(DEFAULT_BACKUP_SELECTION)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('still hands the crash screen its rescue backup, whatever the signed-in role allows', async () => {
    mockGetDriver.mockReturnValue(fakeDriver({ items }));
    signInWithoutBackupRead();

    // The rescue path is the exemption, and it does not consult the session at all: refusing it
    // would only cost an already-broken device the one artefact that can bring its data back.
    await expect(createRescueBackup()).resolves.toBeDefined();
    expect(downloadBlob).toHaveBeenCalledOnce();
  });
});
