/**
 * Unified database error model (spec §2.2.4, §2.1, §7.5).
 *
 * SQLite/worker failures are serialised across the RPC bridge and rebuilt on the
 * main thread as `DbError`, so call sites (repositories, optimistic-update
 * rollbacks, the sync engine in later phases) can branch on a stable `code`
 * rather than parsing raw message strings. Distinguishing SQLITE_BUSY (retryable)
 * from SQLITE_CONSTRAINT_FOREIGNKEY (re-parent, §7.5) is essential downstream.
 */

export type DbErrorCode =
  | 'SQLITE_BUSY'
  | 'SQLITE_LOCKED'
  | 'SQLITE_CONSTRAINT'
  | 'SQLITE_CONSTRAINT_FOREIGNKEY'
  | 'SQLITE_FULL'
  | 'SQLITE_READONLY'
  | 'SQLITE_ERROR'
  | 'FTS5_UNAVAILABLE'
  | 'OPFS_UNAVAILABLE'
  | 'NOT_CROSS_ORIGIN_ISOLATED'
  | 'MULTI_TAB_LOCKED'
  | 'SCHEMA_TOO_NEW'
  // The on-disk database was built by an older revision of the squashed pre-release
  // baseline, so it is missing schema this build expects (§2.3).
  | 'SCHEMA_STALE'
  | 'INIT_FAILED'
  | 'TRANSACTION_FAILED'
  // The database worker died (crash, browser eviction, an unhandled trap), so the OPFS connection
  // it owned is gone for the rest of this page's life — only a reload recovers (§2.2.3).
  | 'WORKER_UNAVAILABLE'
  // The worker accepted a request but never answered it within that call's budget (§2.2.3).
  | 'WORKER_TIMEOUT'
  // The storage Hard Stop (§7.6.1): writes are suspended at the locked tier.
  | 'WRITE_SUSPENDED'
  // The signed-in user's role does not permit this operation (issue #79, plan §2.3). Raised
  // by the repository layer, never by SQLite — permissions gate the app, not the file, since
  // a local database is readable by anyone holding the device (plan §1.1).
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

/** Plain, structured-clone-safe representation sent over the worker bridge. */
export interface SerializedDbError {
  readonly name: 'DbError';
  readonly code: DbErrorCode;
  readonly message: string;
  readonly resultCode?: number;
  readonly sql?: string;
}

export interface DbErrorOptions {
  readonly resultCode?: number;
  readonly sql?: string;
  readonly cause?: unknown;
}

export class DbError extends Error {
  override readonly name = 'DbError';
  readonly code: DbErrorCode;
  /** The raw SQLite (extended) result code, where one is available. */
  readonly resultCode: number | undefined;
  /** The offending SQL, where it is safe and useful to surface. */
  readonly sql: string | undefined;

  constructor(code: DbErrorCode, message: string, options: DbErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.resultCode = options.resultCode;
    this.sql = options.sql;
  }

  /** True for transient lock contention worth retrying (spec §2.2.4). */
  get isRetryable(): boolean {
    return this.code === 'SQLITE_BUSY' || this.code === 'SQLITE_LOCKED';
  }

  toSerialized(): SerializedDbError {
    return {
      name: 'DbError',
      code: this.code,
      message: this.message,
      ...(this.resultCode !== undefined ? { resultCode: this.resultCode } : {}),
      ...(this.sql !== undefined ? { sql: this.sql } : {}),
    };
  }

  static fromSerialized(error: SerializedDbError): DbError {
    return new DbError(error.code, error.message, {
      resultCode: error.resultCode,
      sql: error.sql,
    });
  }

  /** Normalise any thrown value into a DbError, mapping SQLite result codes. */
  static fromUnknown(error: unknown, fallback: DbErrorCode = 'UNKNOWN', sql?: string): DbError {
    if (error instanceof DbError) return error;

    const message = error instanceof Error ? error.message : String(error);
    const resultCode = extractResultCode(error);
    const code = resultCode !== undefined ? mapResultCode(resultCode) : fallback;

    return new DbError(code, message, { resultCode, sql, cause: error });
  }
}

/**
 * Every {@link DbErrorCode}, as a lookup.
 *
 * Typed as an exhaustive record so a code added to the union without being added here fails the
 * build: the guard below is only ever as good as this list.
 */
const DB_ERROR_CODES: Readonly<Record<DbErrorCode, true>> = {
  SQLITE_BUSY: true,
  SQLITE_LOCKED: true,
  SQLITE_CONSTRAINT: true,
  SQLITE_CONSTRAINT_FOREIGNKEY: true,
  SQLITE_FULL: true,
  SQLITE_READONLY: true,
  SQLITE_ERROR: true,
  FTS5_UNAVAILABLE: true,
  OPFS_UNAVAILABLE: true,
  NOT_CROSS_ORIGIN_ISOLATED: true,
  MULTI_TAB_LOCKED: true,
  SCHEMA_TOO_NEW: true,
  SCHEMA_STALE: true,
  INIT_FAILED: true,
  TRANSACTION_FAILED: true,
  WORKER_UNAVAILABLE: true,
  WORKER_TIMEOUT: true,
  WRITE_SUSPENDED: true,
  PERMISSION_DENIED: true,
  UNKNOWN: true,
};

/**
 * Type guard for a code arriving from outside the type system (the worker bridge).
 *
 * `Object.hasOwn`, not `in`: `'constructor'` is on every object's prototype, and an inherited
 * key would let an arbitrary string pass as a `DbErrorCode`.
 */
export function isDbErrorCode(value: unknown): value is DbErrorCode {
  return typeof value === 'string' && Object.hasOwn(DB_ERROR_CODES, value);
}

/**
 * Type guard for the serialised wire form — every field it claims, including the optionals,
 * because {@link DbError.fromSerialized} reads them all straight into a typed `DbError`.
 */
export function isSerializedDbError(value: unknown): value is SerializedDbError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof SerializedDbError, unknown>>;
  return (
    candidate.name === 'DbError' &&
    isDbErrorCode(candidate.code) &&
    typeof candidate.message === 'string' &&
    (candidate.resultCode === undefined || typeof candidate.resultCode === 'number') &&
    (candidate.sql === undefined || typeof candidate.sql === 'string')
  );
}

// --- SQLite result-code mapping -------------------------------------------------

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_FULL = 13;
const SQLITE_CONSTRAINT = 19;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787; // extended code (19 | (9 << 8))

/**
 * Map a primary or extended SQLite result code to our stable error code.
 *
 * @internal Exported for unit tests only.
 */
export function mapResultCode(resultCode: number): DbErrorCode {
  switch (resultCode) {
    case SQLITE_BUSY:
      return 'SQLITE_BUSY';
    case SQLITE_LOCKED:
      return 'SQLITE_LOCKED';
    case SQLITE_READONLY:
      return 'SQLITE_READONLY';
    case SQLITE_FULL:
      return 'SQLITE_FULL';
    case SQLITE_CONSTRAINT_FOREIGNKEY:
      return 'SQLITE_CONSTRAINT_FOREIGNKEY';
    case SQLITE_CONSTRAINT:
      return 'SQLITE_CONSTRAINT';
    default:
      // Collapse the extended-code family onto its primary code (low byte).
      if ((resultCode & 0xff) === SQLITE_CONSTRAINT) return 'SQLITE_CONSTRAINT';
      return 'SQLITE_ERROR';
  }
}

function extractResultCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  // @sqlite.org/sqlite-wasm surfaces SQLite3Error with a numeric `resultCode`.
  const candidate = (error as { resultCode?: unknown }).resultCode;
  return typeof candidate === 'number' ? candidate : undefined;
}
