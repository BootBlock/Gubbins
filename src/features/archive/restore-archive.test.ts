import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { BASELINE_REVISION } from '@/db/migrations';
import {
  ARCHIVE_DB_ENTRY,
  ARCHIVE_IMAGES_PREFIX,
  ARCHIVE_MANIFEST_ENTRY,
  ARCHIVE_MANIFEST_KIND,
  ARCHIVE_MANIFEST_VERSION,
  buildArchiveManifest,
  type ArchiveManifest,
} from './auto-archive';

const prepareDestructiveRestore = vi.hoisted(() => vi.fn());
const overwriteDatabaseFile = vi.hoisted(() => vi.fn());
const writeImageFiles = vi.hoisted(() => vi.fn());

/**
 * Only the two OPFS-touching steps are stubbed; `isSqliteFile` comes from the pure header module
 * it is re-exported from, so the file guard the parse tests rely on stays the real one.
 */
vi.mock('@/app/error/safe-mode-actions', async () => {
  const { isSqliteFile } = await import('@/db/sqlite-header');
  return {
    isSqliteFile,
    prepareDestructiveRestore,
    overwriteDatabaseFile,
    StaleJournalError: class StaleJournalError extends Error {},
    IncompatibleDatabaseError: class IncompatibleDatabaseError extends Error {
      constructor() {
        super('That database was made by a different version of Gubbins.');
        this.name = 'IncompatibleDatabaseError';
      }
    },
  };
});
vi.mock('@/features/images/opfs-images', () => ({ writeImageFiles }));

import { IncompatibleDatabaseError, StaleJournalError } from '@/app/error/safe-mode-actions';
import { InvalidArchiveError, parseArchive, readArchive, restoreArchive } from './restore-archive';
import type { SafeSave } from '@/lib/save-file';

/**
 * Where the restore point goes (issue #502). Opaque here — `prepareDestructiveRestore` is
 * stubbed above and is the only thing that reads it — but it is required, so the calls below
 * pass one rather than pretending a destructive restore can start without a destination.
 */
const SAVE: SafeSave = {
  saver: { filename: 'gubbins-restore-point.sqlite', save: async () => 'saved' },
  confirmUnverified: async () => true,
};

/** Bytes that begin with the SQLite 3 magic header, so they pass the file guard. */
function fakeSqlite(tail = 'payload'): Uint8Array {
  return strToU8(`SQLite format 3\0${tail}`);
}

/** An archive `.zip` as a chosen `File`, so the real read/unzip/parse path runs. */
function archiveFile(entries: Record<string, Uint8Array>): File {
  return new File([zipSync(entries) as unknown as BlobPart], 'gubbins-archive.zip', {
    type: 'application/zip',
  });
}

describe('parseArchive', () => {
  it('extracts the SQLite binary and every image, stripping the images/ prefix', () => {
    const sqlite = fakeSqlite();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const { sqlite: gotDb, images } = parseArchive({
      [ARCHIVE_DB_ENTRY]: sqlite,
      [`${ARCHIVE_IMAGES_PREFIX}one.webp`]: a,
      [`${ARCHIVE_IMAGES_PREFIX}two.webp`]: b,
      'README.md': strToU8('# readme'),
    });

    expect(gotDb).toBe(sqlite);
    expect(images.map((i) => i.name).sort()).toEqual(['one.webp', 'two.webp']);
    expect(images.find((i) => i.name === 'one.webp')?.bytes).toEqual(a);
  });

  it('returns an empty image list when the archive carries only a database', () => {
    const { images } = parseArchive({ [ARCHIVE_DB_ENTRY]: fakeSqlite() });
    expect(images).toEqual([]);
  });

  it('ignores non-file/nested entries under images/ (directory markers, sub-paths)', () => {
    const { images } = parseArchive({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_IMAGES_PREFIX]: new Uint8Array(), // bare directory entry
      [`${ARCHIVE_IMAGES_PREFIX}nested/deep.webp`]: new Uint8Array([9]),
      [`${ARCHIVE_IMAGES_PREFIX}keep.webp`]: new Uint8Array([7]),
    });
    expect(images.map((i) => i.name)).toEqual(['keep.webp']);
  });

  it('throws when the database entry is absent', () => {
    expect(() => parseArchive({ 'README.md': strToU8('x') })).toThrow(InvalidArchiveError);
  });

  it('throws when the database entry is not a SQLite file', () => {
    expect(() => parseArchive({ [ARCHIVE_DB_ENTRY]: strToU8('not a database') })).toThrow(
      InvalidArchiveError,
    );
  });
});

describe('readArchive', () => {
  it('unzips a real archive zip and parses its contents end-to-end', () => {
    const sqlite = fakeSqlite('roundtrip');
    const img = new Uint8Array([10, 20, 30, 40]);
    const zip = zipSync({
      [ARCHIVE_DB_ENTRY]: sqlite,
      [`${ARCHIVE_IMAGES_PREFIX}pic.webp`]: img,
      'README.md': strToU8('# Gubbins full archive'),
    });

    const { sqlite: gotDb, images } = readArchive(zip);
    expect(gotDb).toEqual(sqlite);
    expect(images).toEqual([{ name: 'pic.webp', bytes: img }]);
  });

  it('throws InvalidArchiveError on bytes that are not a valid zip', () => {
    expect(() => readArchive(strToU8('definitely not a zip'))).toThrow(InvalidArchiveError);
  });
});

/** The archive's `manifest.json`, as JSON bytes ready to place in a zip. */
function manifestEntry(overrides: Partial<ArchiveManifest> = {}): Uint8Array {
  const base = buildArchiveManifest({
    appVersion: '0.9.1',
    baselineRevision: BASELINE_REVISION,
    createdAt: new Date('2026-07-27T09:30:00.000Z'),
    imageCount: 0,
  });
  return strToU8(JSON.stringify({ ...base, ...overrides }));
}

describe('parseArchive — manifest (issue #501)', () => {
  it('reads back a manifest this build wrote', () => {
    const { manifest } = parseArchive({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_MANIFEST_ENTRY]: manifestEntry(),
    });
    expect(manifest).toEqual({
      kind: ARCHIVE_MANIFEST_KIND,
      formatVersion: ARCHIVE_MANIFEST_VERSION,
      appVersion: '0.9.1',
      baselineRevision: BASELINE_REVISION,
      createdAt: '2026-07-27T09:30:00.000Z',
      counts: { images: 0 },
    });
  });

  it('reports no manifest for an archive written before manifests existed', () => {
    expect(parseArchive({ [ARCHIVE_DB_ENTRY]: fakeSqlite() }).manifest).toBeNull();
  });

  it.each([
    ['not JSON at all', strToU8('{{{')],
    ['a JSON array', strToU8('[]')],
    ['some other file that happens to be named manifest.json', strToU8('{"kind":"something-else"}')],
    ['a manifest missing its baseline stamp', strToU8('{"kind":"gubbins-full-archive"}')],
  ])('treats %s as no manifest rather than a malformed one', (_label, bytes) => {
    // Forgiving on purpose, unlike a backup's manifest: this one can only *add* a refusal the
    // database bytes would earn anyway, so refusing the whole archive over it would strand a
    // user whose data is perfectly fine.
    expect(
      parseArchive({ [ARCHIVE_DB_ENTRY]: fakeSqlite(), [ARCHIVE_MANIFEST_ENTRY]: bytes }).manifest,
    ).toBeNull();
  });

  it('does not mistake the manifest for an image', () => {
    const { images } = parseArchive({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_MANIFEST_ENTRY]: manifestEntry(),
    });
    expect(images).toEqual([]);
  });
});

describe('restoreArchive — schema baseline (issue #501)', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { reload: vi.fn() });
    writeImageFiles.mockResolvedValue({ failed: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('refuses an archive whose manifest names another baseline, before any OPFS write', async () => {
    // The archive is the *automatic weekly* net for mobile users, so the one being restored is
    // often several releases old — and this refusal needs no worker, which is the case the
    // bytes-level check cannot cover on a crash screen.
    const file = archiveFile({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_MANIFEST_ENTRY]: manifestEntry({ baselineRevision: 'deadbeef' }),
    });

    await expect(restoreArchive(file, { save: SAVE })).rejects.toBeInstanceOf(IncompatibleDatabaseError);

    expect(prepareDestructiveRestore).not.toHaveBeenCalled();
    expect(overwriteDatabaseFile).not.toHaveBeenCalled();
    expect(writeImageFiles).not.toHaveBeenCalled();
  });

  it('restores an archive whose manifest matches this build', async () => {
    const file = archiveFile({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_MANIFEST_ENTRY]: manifestEntry(),
    });

    await restoreArchive(file, { save: SAVE });

    expect(prepareDestructiveRestore).toHaveBeenCalledOnce();
    expect(overwriteDatabaseFile).toHaveBeenCalledOnce();
  });

  it('leaves a manifest-less archive to the pre-flight, which reads the database itself', async () => {
    await restoreArchive(archiveFile({ [ARCHIVE_DB_ENTRY]: fakeSqlite() }), { save: SAVE });

    expect(prepareDestructiveRestore).toHaveBeenCalledOnce();
    expect(overwriteDatabaseFile).toHaveBeenCalledOnce();
  });

  it('honours the override so a user who means it is not dead-ended', async () => {
    const file = archiveFile({
      [ARCHIVE_DB_ENTRY]: fakeSqlite(),
      [ARCHIVE_MANIFEST_ENTRY]: manifestEntry({ baselineRevision: 'deadbeef' }),
    });

    await restoreArchive(file, { force: true, save: SAVE });

    expect(overwriteDatabaseFile).toHaveBeenCalledOnce();
  });
});

/**
 * Issue #639: the images are written *after* the database bytes have committed, so a write that
 * fails there is a restore that already happened minus some pictures. Unwinding it told the user
 * "the restore failed" over data that was already gone, and — because the worker is disposed by
 * the overwrite — skipped the reload that is the only thing making the app usable again.
 */
describe('restoreArchive — images that will not write (issue #639)', () => {
  const IMAGES = {
    [`${ARCHIVE_IMAGES_PREFIX}one.webp`]: new Uint8Array([1]),
    [`${ARCHIVE_IMAGES_PREFIX}two.webp`]: new Uint8Array([2]),
  };

  beforeEach(() => {
    vi.stubGlobal('location', { reload: vi.fn() });
    writeImageFiles.mockResolvedValue({ failed: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reloads and reports nothing missed when every image lands', async () => {
    writeImageFiles.mockResolvedValue({ failed: [] });

    const outcome = await restoreArchive(archiveFile({ [ARCHIVE_DB_ENTRY]: fakeSqlite(), ...IMAGES }), {
      save: SAVE,
    });

    expect(outcome).toEqual({ images: 2, imagesMissed: 0 });
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('reports the shortfall instead of throwing, and leaves the reload to the caller', async () => {
    writeImageFiles.mockResolvedValue({
      failed: ['two.webp'],
      failure: new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    });

    const outcome = await restoreArchive(archiveFile({ [ARCHIVE_DB_ENTRY]: fakeSqlite(), ...IMAGES }), {
      save: SAVE,
    });

    expect(outcome).toEqual({ images: 2, imagesMissed: 1 });
    // The database is already replaced and the worker released; reloading before the user has
    // read what is missing would bury the only news this restore has to give.
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('still refuses to reload when the database landed beside a stale journal (#203)', async () => {
    // Deliberately a *clean* image run: with images missed as well, the reload would be blocked
    // by the shortfall alone and this would pass however the two were ordered. Every image
    // landing leaves the stale journal as the only thing that can stop it — which is the
    // ordering #203 depends on, since reloading beside a hot journal rolls the restore back.
    overwriteDatabaseFile.mockRejectedValueOnce(new StaleJournalError('gubbins.sqlite3-wal'));
    writeImageFiles.mockResolvedValue({ failed: [] });

    await expect(
      restoreArchive(archiveFile({ [ARCHIVE_DB_ENTRY]: fakeSqlite(), ...IMAGES }), { save: SAVE }),
    ).rejects.toBeInstanceOf(StaleJournalError);

    expect(writeImageFiles).toHaveBeenCalledOnce();
    expect(location.reload).not.toHaveBeenCalled();
  });
});
