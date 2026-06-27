import { describe, it, expect } from 'vitest';
import { DbError, mapResultCode, isSerializedDbError } from './errors';

describe('SQLite result-code mapping', () => {
  it('maps primary result codes', () => {
    expect(mapResultCode(5)).toBe('SQLITE_BUSY');
    expect(mapResultCode(6)).toBe('SQLITE_LOCKED');
    expect(mapResultCode(8)).toBe('SQLITE_READONLY');
    expect(mapResultCode(13)).toBe('SQLITE_FULL');
    expect(mapResultCode(19)).toBe('SQLITE_CONSTRAINT');
  });

  it('maps the extended foreign-key constraint code', () => {
    expect(mapResultCode(787)).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('collapses other extended constraint codes onto SQLITE_CONSTRAINT', () => {
    // SQLITE_CONSTRAINT_NOTNULL = 1299 → low byte is 19 (SQLITE_CONSTRAINT).
    expect(mapResultCode(1299)).toBe('SQLITE_CONSTRAINT');
  });

  it('falls back to SQLITE_ERROR for unknown codes', () => {
    expect(mapResultCode(1)).toBe('SQLITE_ERROR');
  });
});

describe('DbError', () => {
  it('flags busy/locked failures as retryable, others not', () => {
    expect(new DbError('SQLITE_BUSY', 'x').isRetryable).toBe(true);
    expect(new DbError('SQLITE_LOCKED', 'x').isRetryable).toBe(true);
    expect(new DbError('SQLITE_CONSTRAINT', 'x').isRetryable).toBe(false);
  });

  it('round-trips through serialisation', () => {
    const original = new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', 'fk violation', {
      resultCode: 787,
      sql: 'INSERT INTO items ...',
    });
    const serialized = original.toSerialized();

    expect(isSerializedDbError(serialized)).toBe(true);

    const restored = DbError.fromSerialized(serialized);
    expect(restored).toBeInstanceOf(DbError);
    expect(restored.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(restored.resultCode).toBe(787);
    expect(restored.sql).toBe('INSERT INTO items ...');
  });

  it('returns the same instance from fromUnknown when already a DbError', () => {
    const original = new DbError('SQLITE_BUSY', 'busy');
    expect(DbError.fromUnknown(original)).toBe(original);
  });

  it('normalises a plain Error to an UNKNOWN DbError', () => {
    const error = DbError.fromUnknown(new Error('boom'));
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toBe('boom');
  });

  it('extracts a resultCode from sqlite-wasm-style errors', () => {
    const error = DbError.fromUnknown({ message: 'database is locked', resultCode: 5 });
    expect(error.code).toBe('SQLITE_BUSY');
    expect(error.resultCode).toBe(5);
  });
});
