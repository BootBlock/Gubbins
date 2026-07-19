/**
 * Pure inspection of a candidate `.sqlite` file's 100-byte header (issue #198).
 *
 * A restore overwrites the live database irreversibly, so the bytes handed to it must be
 * checked *before* anything is written. The magic string alone is only 16 bytes — an
 * interrupted download, a file copied off a failing drive and a half-synced cloud file all
 * carry a perfect header and nothing behind it. The header, though, records the page size
 * and (when the change counter agrees) the database's own page count, so a truncated file
 * can be caught arithmetically without opening it.
 *
 * This is the cheap first gate: pure, synchronous, and — unlike
 * `verifySqliteBinary` — it needs no worker, which matters because Safe Mode is
 * exactly where the worker may be dead. Field offsets are from the SQLite file format
 * specification (§1.3 "The Database Header").
 */

/** The 16-byte magic string every SQLite 3 database file begins with. */
export const SQLITE_MAGIC = 'SQLite format 3\0';

/** The fixed size of the SQLite database header, in bytes. */
const HEADER_BYTES = 100;

const OFFSET_PAGE_SIZE = 16;
const OFFSET_WRITE_VERSION = 18;
const OFFSET_READ_VERSION = 19;
const OFFSET_RESERVED_SPACE = 20;
const OFFSET_CHANGE_COUNTER = 24;
const OFFSET_PAGE_COUNT = 28;
const OFFSET_VERSION_VALID_FOR = 92;

/** What the header says about a candidate database file. */
export interface SqliteHeaderReport {
  /** The file begins with the SQLite 3 magic string (a bare format check). */
  readonly isSqlite: boolean;
  /** The header is present, self-consistent, and the file's length agrees with it. */
  readonly ok: boolean;
  /** Bytes per page, or `null` when the field is absent or not a legal value. */
  readonly pageSize: number | null;
  /** Human-readable descriptions of every problem found (empty when `ok`). */
  readonly problems: readonly string[];
}

/**
 * Read and sanity-check the header of `bytes`. Never throws; a file that is not a SQLite
 * database at all comes back with `isSqlite: false` and a single problem.
 */
export function inspectSqliteHeader(bytes: Uint8Array): SqliteHeaderReport {
  if (!hasMagic(bytes)) {
    return {
      isSqlite: false,
      ok: false,
      pageSize: null,
      problems: ['The file does not begin with a SQLite database header.'],
    };
  }
  if (bytes.length < HEADER_BYTES) {
    return {
      isSqlite: true,
      ok: false,
      pageSize: null,
      problems: [`The file is only ${bytes.length} bytes — too short to hold a database header.`],
    };
  }

  // A DataView over the header does the big-endian reads the format specifies, and keeps every
  // access bounds-checked now that the 100-byte minimum above is established.
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const problems: string[] = [];
  const pageSize = readPageSize(header);

  if (pageSize === null) {
    problems.push('The header records an invalid page size, so the file is damaged.');
  } else {
    // Every SQLite database is a whole number of equally-sized pages. A file that stops
    // part-way through one was truncated in transit — the single most likely corruption
    // for a download or a cloud sync that never finished.
    if (bytes.length % pageSize !== 0) {
      problems.push(
        `The file is ${bytes.length} bytes, which is not a whole number of ${pageSize}-byte pages — it looks truncated.`,
      );
    }
    // The header's own page count is only authoritative when the change counter and the
    // version-valid-for number agree; otherwise the file was last written by a legacy
    // version that left the field stale, and the size on disk is the truth.
    const declaredPages = header.getUint32(OFFSET_PAGE_COUNT);
    const pageCountIsValid =
      declaredPages > 0 &&
      header.getUint32(OFFSET_CHANGE_COUNTER) === header.getUint32(OFFSET_VERSION_VALID_FOR);
    if (pageCountIsValid && bytes.length < declaredPages * pageSize) {
      problems.push(
        `The database says it holds ${declaredPages} pages (${declaredPages * pageSize} bytes) but the file is only ${bytes.length} bytes — it is incomplete.`,
      );
    }
  }

  const writeVersion = header.getUint8(OFFSET_WRITE_VERSION);
  const readVersion = header.getUint8(OFFSET_READ_VERSION);
  if (writeVersion !== 1 && writeVersion !== 2) {
    problems.push(`The header's write format version (${writeVersion}) is not a value SQLite writes.`);
  }
  if (readVersion !== 1 && readVersion !== 2) {
    problems.push(`The header's read format version (${readVersion}) is not a value SQLite writes.`);
  }
  // Reserved space is carved out of the end of every page; a value that leaves no usable
  // page is impossible, and the specification caps the usable remainder at 480 bytes.
  if (pageSize !== null && header.getUint8(OFFSET_RESERVED_SPACE) > pageSize - 480) {
    problems.push("The header's reserved-space field is larger than a page can hold.");
  }

  return { isSqlite: true, ok: problems.length === 0, pageSize, problems };
}

/**
 * Whether `bytes` begins with the SQLite 3 file header. The bare format check — a stray
 * JSON file or image can never overwrite the live database — kept separate from
 * {@link inspectSqliteHeader}'s structural checks because the two carry different
 * consequences: this one is unambiguously the wrong file, those mean a damaged right one.
 */
export function isSqliteFile(bytes: Uint8Array): boolean {
  return hasMagic(bytes);
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** The page size in bytes, or `null` when the field is not a legal SQLite value. */
function readPageSize(header: DataView): number | null {
  const raw = header.getUint16(OFFSET_PAGE_SIZE);
  // The value 1 is the format's escape hatch for the maximum 65536-byte page, which
  // does not fit the 16-bit field.
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536) return null;
  if ((pageSize & (pageSize - 1)) !== 0) return null; // must be a power of two
  return pageSize;
}
