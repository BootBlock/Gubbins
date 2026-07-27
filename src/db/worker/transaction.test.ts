import { describe, it, expect } from 'vitest';
import { DbError } from '../errors';
import { executeTransaction, type TransactionConnection } from './transaction';
import type { SqlParams, SqlStatement } from '../rpc/driver';

/**
 * A scriptable stand-in for the worker's SQLite connection.
 *
 * The whole point of issue #555 is a `ROLLBACK` that fails — which no real connection will do on
 * demand, since it takes an OPFS-level fault to provoke. So the fake models the two things the
 * guard actually reads: what each statement does, and whether the transaction is still open
 * afterwards.
 */
interface FakeConnection extends TransactionConnection {
  /** Every statement run, in order. */
  readonly log: readonly { readonly sql: string; readonly params?: SqlParams }[];
  /** How many times the connection was thrown away. */
  readonly discards: number;
}

interface FakeFailure {
  readonly error: unknown;
  /**
   * The transaction state SQLite is left in by the failure. Omitted means unchanged — the usual
   * case, where a failed statement leaves the transaction open for the caller to roll back.
   */
  readonly leavesTransactionOpen?: boolean;
}

function createFakeConnection(failures: Readonly<Record<string, FakeFailure>> = {}): FakeConnection {
  const log: { sql: string; params?: SqlParams }[] = [];
  let open = false;
  let discards = 0;

  return {
    log,
    get discards() {
      return discards;
    },
    exec(sql: string, params?: SqlParams): void {
      log.push({ sql, params });
      const failure = failures[sql];
      if (failure) {
        if (failure.leavesTransactionOpen !== undefined) open = failure.leavesTransactionOpen;
        throw failure.error;
      }
      if (sql === 'BEGIN;') open = true;
      if (sql === 'COMMIT;' || sql === 'ROLLBACK;') open = false;
    },
    inTransaction: () => open,
    discard: () => {
      discards += 1;
      open = false;
    },
  };
}

/** SQLite's own shape for a failure: a message plus the numeric result code. */
function sqliteError(message: string, resultCode: number): Error {
  return Object.assign(new Error(message), { resultCode });
}

/** Run `execute` and return whatever it threw, failing the test if it threw nothing. */
function catchError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the transaction to throw.');
}

const STATEMENTS: readonly SqlStatement[] = [
  { sql: 'INSERT INTO items (id) VALUES (?);', params: ['item-1'] },
  { sql: 'DELETE FROM items WHERE id = ?;', params: ['item-2'] },
];

describe('executeTransaction', () => {
  it('wraps the batch in BEGIN...COMMIT, forwarding each statement’s parameters', () => {
    const connection = createFakeConnection();

    executeTransaction(connection, STATEMENTS);

    expect(connection.log).toEqual([
      { sql: 'BEGIN;', params: undefined },
      { sql: 'INSERT INTO items (id) VALUES (?);', params: ['item-1'] },
      { sql: 'DELETE FROM items WHERE id = ?;', params: ['item-2'] },
      { sql: 'COMMIT;', params: undefined },
    ]);
    expect(connection.inTransaction()).toBe(false);
    expect(connection.discards).toBe(0);
  });

  it('rolls back a failed batch and reports the original failure', () => {
    const connection = createFakeConnection({
      'DELETE FROM items WHERE id = ?;': { error: sqliteError('FOREIGN KEY constraint failed', 787) },
    });

    const failure = catchError(() => executeTransaction(connection, STATEMENTS));

    expect(failure).toBeInstanceOf(DbError);
    expect(failure).toMatchObject({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'FOREIGN KEY constraint failed',
    });
    expect(connection.log.map((entry) => entry.sql).at(-1)).toBe('ROLLBACK;');
    expect(connection.inTransaction()).toBe(false);
    expect(connection.discards).toBe(0);
  });

  it('keeps the connection when ROLLBACK throws but SQLite has already unwound the transaction', () => {
    const connection = createFakeConnection({
      'COMMIT;': { error: sqliteError('database or disk is full', 13) },
      // SQLite rolled back automatically, which is *why* the explicit rollback complains.
      'ROLLBACK;': {
        error: new Error('cannot rollback - no transaction is active'),
        leavesTransactionOpen: false,
      },
    });

    const failure = catchError(() => executeTransaction(connection, STATEMENTS));

    expect(failure).toBeInstanceOf(DbError);
    expect(failure).toMatchObject({ code: 'SQLITE_FULL', message: 'database or disk is full' });
    expect(connection.discards).toBe(0);
  });

  it('discards the connection when the failed rollback leaves the transaction open', () => {
    const rollbackError = sqliteError('disk I/O error', 10);
    const connection = createFakeConnection({
      'COMMIT;': { error: sqliteError('database or disk is full', 13) },
      'ROLLBACK;': { error: rollbackError, leavesTransactionOpen: true },
    });

    const failure = catchError(() => executeTransaction(connection, STATEMENTS)) as DbError;

    expect(connection.discards).toBe(1);
    // The original failure is still the one reported, verbatim — its code is what tells the user
    // their storage is full, and the humanising layer parses the message SQLite wrote — with the
    // rollback failure attached rather than swallowed.
    expect(failure).toBeInstanceOf(DbError);
    expect(failure.code).toBe('SQLITE_FULL');
    expect(failure.resultCode).toBe(13);
    expect(failure.message).toBe('database or disk is full');
    expect(failure.cause).toBe(rollbackError);
  });

  it('unwinds a failing BEGIN rather than propagating with the connection unexamined', () => {
    const connection = createFakeConnection({
      // The state this bug used to leave behind: a transaction from an earlier batch, still open.
      'BEGIN;': {
        error: new Error('cannot start a transaction within a transaction'),
        leavesTransactionOpen: true,
      },
      'ROLLBACK;': { error: sqliteError('disk I/O error', 10), leavesTransactionOpen: true },
    });

    const failure = catchError(() => executeTransaction(connection, STATEMENTS)) as DbError;

    expect(connection.log.map((entry) => entry.sql)).toEqual(['BEGIN;', 'ROLLBACK;']);
    expect(connection.discards).toBe(1);
    expect(failure.message).toContain('cannot start a transaction within a transaction');
  });

  it('discards the connection when the transaction state cannot be read at all', () => {
    const connection = createFakeConnection({
      'COMMIT;': { error: sqliteError('database or disk is full', 13) },
    });
    const unreadable: TransactionConnection = {
      ...connection,
      inTransaction: () => {
        throw new TypeError('sqlite3_get_autocommit is not a function');
      },
    };

    const failure = catchError(() => executeTransaction(unreadable, STATEMENTS)) as DbError;

    // The guard's own fault must never become the error the user is shown.
    expect(failure.message).toBe('database or disk is full');
    expect(connection.discards).toBe(1);
  });

  it('recovers a stray open transaction when the rollback succeeds, without discarding', () => {
    const connection = createFakeConnection({
      'BEGIN;': {
        error: new Error('cannot start a transaction within a transaction'),
        leavesTransactionOpen: true,
      },
    });

    const failure = catchError(() => executeTransaction(connection, STATEMENTS)) as DbError;

    expect(failure.message).toContain('cannot start a transaction within a transaction');
    expect(connection.inTransaction()).toBe(false);
    expect(connection.discards).toBe(0);
  });
});
