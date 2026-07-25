/**
 * Which VFS the database opens on (issue #255).
 *
 * The primary `opfs` VFS only registers under cross-origin isolation, and on WebKit only from
 * Safari 17 — so iOS 16 (and anything a proxy strips the COOP/COEP headers from) used to hit a
 * blocking boot screen. It now falls back to `opfs-sahpool`, which needs neither.
 *
 * The rule these tests pin is not "prefer the primary" but "**follow the data**": whichever VFS
 * already holds this origin's database keeps holding it. Getting that wrong in either direction
 * is a data-loss bug rather than a preference — open a fresh pool while a real database sits in
 * the primary VFS and the user is shown an empty app they will start typing into.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const initModule = vi.hoisted(() => vi.fn());
vi.mock('@sqlite.org/sqlite-wasm', () => ({ default: initModule }));

import { SAHPOOL_DIRECTORY } from '../db-storage';

/** A stand-in database handle: the bootstrap only PRAGMAs and probes FTS5 through it. */
function fakeDb(label: string) {
  return {
    label,
    exec: vi.fn(),
    close: vi.fn(),
    selectValue: vi.fn(() => 1),
  };
}

const sahPoolDb = fakeDb('sahpool');
const primaryDb = fakeDb('opfs');
const installOpfsSAHPoolVfs = vi.fn(async () => ({
  vfsName: 'opfs-sahpool',
  OpfsSAHPoolDb: function OpfsSAHPoolDb() {
    return sahPoolDb;
  },
}));

/** Configure the loaded module: `primaryVfs` mirrors sqlite-wasm registering `oo1.OpfsDb`. */
function stubSqlite(options: { primaryVfs: boolean }) {
  initModule.mockResolvedValue({
    version: { libVersion: '3.53.0' },
    installOpfsSAHPoolVfs,
    oo1: options.primaryVfs
      ? {
          OpfsDb: function OpfsDb() {
            return primaryDb;
          },
        }
      : {},
  });
}

/** Configure OPFS: which of the two stores this origin already has, if either. */
function stubOpfs(store: 'plain-database' | 'sahpool' | 'empty') {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () => {
          if (store !== 'plain-database') throw new DOMException('No such file.', 'NotFoundError');
          return { getFile: async () => new File([new Uint8Array(4096)], 'gubbins.sqlite3') };
        },
        getDirectoryHandle: async (name: string) => {
          if (store !== 'sahpool' || name !== SAHPOOL_DIRECTORY) {
            throw new DOMException('No such directory.', 'NotFoundError');
          }
          return {};
        },
      }),
    },
  });
}

/** Re-import with the module-level caches (the loaded module, the installed pool) cleared. */
async function freshBootstrap() {
  vi.resetModules();
  return await import('./sqlite-bootstrap');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('bootstrapDatabase — VFS selection', () => {
  it('opens the primary OPFS VFS where the browser provides it', async () => {
    stubSqlite({ primaryVfs: true });
    stubOpfs('empty');

    const { bootstrapDatabase } = await freshBootstrap();

    expect((await bootstrapDatabase()).vfs).toBe('opfs');
    expect(installOpfsSAHPoolVfs).not.toHaveBeenCalled();
  });

  it('falls back to opfs-sahpool where it does not — instead of refusing to start', async () => {
    // The iOS 16 case, and any browser whose COOP/COEP headers do not survive the network.
    stubSqlite({ primaryVfs: false });
    stubOpfs('empty');

    const { bootstrapDatabase } = await freshBootstrap();

    expect((await bootstrapDatabase()).vfs).toBe('opfs-sahpool');
    expect(installOpfsSAHPoolVfs).toHaveBeenCalledWith(
      expect.objectContaining({ directory: SAHPOOL_DIRECTORY }),
    );
  });

  it('keeps using the pool once one holds the data, even when isolation comes back', async () => {
    // Switching to the primary VFS here would open an *empty* database beside a full one.
    stubSqlite({ primaryVfs: true });
    stubOpfs('sahpool');

    const { bootstrapDatabase } = await freshBootstrap();

    expect((await bootstrapDatabase()).vfs).toBe('opfs-sahpool');
  });

  it('refuses to open a pool while the real database sits in the primary VFS', async () => {
    // The mirror image, and the more dangerous one: a fallback here would present an empty app
    // that the user then writes into, with their inventory still on disk and out of reach.
    stubSqlite({ primaryVfs: false });
    stubOpfs('plain-database');

    const { bootstrapDatabase } = await freshBootstrap();

    await expect(bootstrapDatabase()).rejects.toMatchObject({ code: 'OPFS_UNAVAILABLE' });
    expect(installOpfsSAHPoolVfs).not.toHaveBeenCalled();
  });
});

describe('resolveVfsTarget — where a restore must write', () => {
  it.each([
    ['plain-database', true, 'opfs'],
    ['sahpool', true, 'sahpool'],
    ['empty', true, 'opfs'],
    // A fresh install answers from what the browser can do, since nothing on disk can.
    ['empty', false, 'sahpool'],
  ] as const)('store %s with primary VFS %s → %s', async (store, primaryVfs, expected) => {
    stubSqlite({ primaryVfs });
    stubOpfs(store);

    const { resolveVfsTarget } = await freshBootstrap();

    expect(await resolveVfsTarget()).toBe(expected);
  });
});
