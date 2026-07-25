/**
 * The worker-side database-file operations (issue #255).
 *
 * Under the `opfs-sahpool` VFS the database is not a file any directory handle can reach, so a
 * restore that wrote the plain OPFS path would appear to succeed and change nothing — the exact
 * silent failure these tests exist to prevent. They pin that each operation goes through the
 * pool when the pool is what holds the data, and through OPFS when it isn't.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveVfsTarget = vi.hoisted(() => vi.fn());
const pool = vi.hoisted(() => ({
  getFileNames: vi.fn(() => ['/gubbins.sqlite3']),
  exportFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  importDb: vi.fn(async () => 4096),
  unlink: vi.fn(() => true),
  wipeFiles: vi.fn(async () => {}),
}));

vi.mock('./sqlite-bootstrap', () => ({
  resolveVfsTarget,
  loadSahPool: async () => pool,
}));

const writePlainDatabaseFile = vi.hoisted(() =>
  vi.fn(async () => ({ staleSidecar: null, cause: undefined })),
);
const deletePlainDatabaseFiles = vi.hoisted(() => vi.fn(async () => {}));
const readPlainDatabaseFile = vi.hoisted(() => vi.fn(async () => null as File | null));

vi.mock('../db-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db-storage')>()),
  writePlainDatabaseFile,
  deletePlainDatabaseFiles,
  readPlainDatabaseFile,
}));

import { readDatabaseFile, wipeDatabaseFiles, writeDatabaseFile } from './db-file-store';

beforeEach(() => {
  vi.clearAllMocks();
  pool.getFileNames.mockReturnValue(['/gubbins.sqlite3']);
});

describe('on the opfs-sahpool VFS', () => {
  beforeEach(() => resolveVfsTarget.mockResolvedValue('sahpool'));

  it('exports the database through the pool rather than the OPFS path', async () => {
    expect(await readDatabaseFile()).toEqual(new Uint8Array([1, 2, 3]));
    expect(readPlainDatabaseFile).not.toHaveBeenCalled();
  });

  it('reports no database when the pool holds none', async () => {
    pool.getFileNames.mockReturnValue([]);
    expect(await readDatabaseFile()).toBeNull();
    expect(pool.exportFile).not.toHaveBeenCalled();
  });

  it('imports a restore into the pool and clears the sidecars it left behind', async () => {
    const bytes = new Uint8Array([4, 5, 6]);

    expect(await writeDatabaseFile(bytes)).toEqual({ staleSidecar: null });

    expect(pool.importDb).toHaveBeenCalledWith('/gubbins.sqlite3', bytes);
    expect(pool.unlink.mock.calls.map(([name]) => name)).toEqual([
      '/gubbins.sqlite3-journal',
      '/gubbins.sqlite3-wal',
      '/gubbins.sqlite3-shm',
    ]);
    expect(writePlainDatabaseFile).not.toHaveBeenCalled();
  });

  it('lets the VFS blank its own files on a purge', async () => {
    await wipeDatabaseFiles();
    expect(pool.wipeFiles).toHaveBeenCalledOnce();
    expect(deletePlainDatabaseFiles).not.toHaveBeenCalled();
  });
});

describe('on the primary OPFS VFS', () => {
  beforeEach(() => resolveVfsTarget.mockResolvedValue('opfs'));

  it('writes the plain file, and reports a sidecar it could not clear', async () => {
    writePlainDatabaseFile.mockResolvedValue({ staleSidecar: 'gubbins.sqlite3-wal', cause: undefined });

    expect(await writeDatabaseFile(new Uint8Array([7]))).toEqual({ staleSidecar: 'gubbins.sqlite3-wal' });
    expect(pool.importDb).not.toHaveBeenCalled();
  });

  it('reads the plain file, treating an empty husk as no database', async () => {
    readPlainDatabaseFile.mockResolvedValue(new File([], 'gubbins.sqlite3'));
    expect(await readDatabaseFile()).toBeNull();
  });

  it('deletes the plain file and its sidecars on a purge', async () => {
    await wipeDatabaseFiles();
    expect(deletePlainDatabaseFiles).toHaveBeenCalledOnce();
    expect(pool.wipeFiles).not.toHaveBeenCalled();
  });
});
