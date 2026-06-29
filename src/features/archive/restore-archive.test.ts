import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { ARCHIVE_DB_ENTRY, ARCHIVE_IMAGES_PREFIX } from './auto-archive';
import { InvalidArchiveError, parseArchive, readArchive } from './restore-archive';

/** Bytes that begin with the SQLite 3 magic header, so they pass the file guard. */
function fakeSqlite(tail = 'payload'): Uint8Array {
  return strToU8(`SQLite format 3\0${tail}`);
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
