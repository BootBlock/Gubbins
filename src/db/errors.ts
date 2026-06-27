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
  | 'INIT_FAILED'
  | 'TRANSACTION_FAILED'
  // The storage Hard Stop (§7.6.1): writes are suspended at the locked tier.
  | 'WRITE_SUSPENDED'
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

/** Type guard for the serialised wire form. */
export function isSerializedDbError(value: unknown): value is SerializedDbError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'DbError' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

// --- SQLite result-code mapping -------------------------------------------------

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_FULL = 13;
const SQLITE_CONSTRAINT = 19;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787; // extended code (19 | (9 << 8))

/** Map a primary or extended SQLite result code to our stable error code. */
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
