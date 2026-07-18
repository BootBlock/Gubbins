import { describe, expect, it } from 'vitest';
import { DbError, type DbErrorCode } from '@/db/errors';
import en from '@/features/i18n/catalogs/en.json';
import { describeDbError, hasAuthoredMessage, isRawSqliteMessage } from './db-error-message';

const catalog = en as Record<string, string>;

describe('isRawSqliteMessage', () => {
  it.each([
    'UNIQUE constraint failed: tags.name',
    'FOREIGN KEY constraint failed',
    'NOT NULL constraint failed: contacts.name',
    'no such column: items.wibble',
    'database or disk is full',
    'attempt to write a readonly database',
    'disk I/O error',
    '',
    '   ',
  ])('treats %j as raw SQLite output', (message) => {
    expect(isRawSqliteMessage(message)).toBe(true);
  });

  it.each([
    'Enter a valid URL (http or https).',
    'An attachment requires a value.',
    'Attachment "abc" does not exist.',
    'Could not check the item back in.',
  ])('treats %j as an authored sentence', (message) => {
    expect(isRawSqliteMessage(message)).toBe(false);
  });
});

describe('describeDbError', () => {
  it('returns undefined for values that are not DbErrors', () => {
    expect(describeDbError(new Error('UNIQUE constraint failed: tags.name'))).toBeUndefined();
    expect(describeDbError('boom')).toBeUndefined();
    expect(describeDbError(undefined)).toBeUndefined();
  });

  it.each<[DbErrorCode, string]>([
    ['SQLITE_BUSY', 'db.error.busy'],
    ['SQLITE_LOCKED', 'db.error.busy'],
    ['SQLITE_FULL', 'db.error.full'],
    ['SQLITE_READONLY', 'db.error.readOnly'],
    ['WRITE_SUSPENDED', 'db.error.writeSuspended'],
    ['MULTI_TAB_LOCKED', 'db.error.multiTab'],
    ['OPFS_UNAVAILABLE', 'db.error.opfsUnavailable'],
    ['NOT_CROSS_ORIGIN_ISOLATED', 'db.error.notIsolated'],
    ['SCHEMA_TOO_NEW', 'db.error.schemaTooNew'],
    ['SCHEMA_STALE', 'db.error.schemaStale'],
    ['FTS5_UNAVAILABLE', 'db.error.ftsUnavailable'],
  ])('humanises the environmental code %s', (code, key) => {
    expect(describeDbError(new DbError(code, 'database or disk is full'))).toEqual({ key });
  });

  it('humanises an environmental code even when its message reads as a sentence', () => {
    // These codes are never thrown with authored copy by our own repositories, and their raw text
    // is the least actionable of all — so they humanise unconditionally.
    expect(describeDbError(new DbError('SQLITE_FULL', 'Storage ran out.'))).toEqual({
      key: 'db.error.full',
    });
  });

  it.each<[DbErrorCode]>([['SQLITE_ERROR'], ['INIT_FAILED'], ['TRANSACTION_FAILED'], ['UNKNOWN']])(
    'declines to describe %s, leaving the call site its own copy',
    (code) => {
      expect(describeDbError(new DbError(code, 'no such table: wibble'))).toBeUndefined();
    },
  );

  describe('constraint failures', () => {
    it('names the field for a known single-column UNIQUE violation', () => {
      const error = new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed: tags.name');
      expect(describeDbError(error)).toEqual({
        key: 'db.error.uniqueField',
        fieldKey: 'db.field.tagName',
      });
    });

    it('falls back to the generic sentence for an unmapped column', () => {
      const error = new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed: widgets.code');
      expect(describeDbError(error)).toEqual({ key: 'db.error.unique' });
    });

    it('falls back to the generic sentence for a composite UNIQUE violation', () => {
      const error = new DbError(
        'SQLITE_CONSTRAINT',
        'UNIQUE constraint failed: capabilities.item_id, capabilities.key',
      );
      expect(describeDbError(error)).toEqual({ key: 'db.error.unique' });
    });

    it('names the field for a known NOT NULL violation', () => {
      const error = new DbError('SQLITE_CONSTRAINT', 'NOT NULL constraint failed: contacts.name');
      expect(describeDbError(error)).toEqual({
        key: 'db.error.notNullField',
        fieldKey: 'db.field.contactName',
      });
    });

    it('handles a CHECK violation and an unrecognised constraint shape', () => {
      expect(describeDbError(new DbError('SQLITE_CONSTRAINT', 'CHECK constraint failed: qty'))).toEqual({
        key: 'db.error.check',
      });
      expect(describeDbError(new DbError('SQLITE_CONSTRAINT', 'constraint failed'))).toEqual({
        key: 'db.error.constraint',
      });
    });

    it('humanises a foreign-key failure', () => {
      const error = new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed');
      expect(describeDbError(error)).toEqual({ key: 'db.error.foreignKey' });
    });

    it('recognises a foreign-key failure reported under the primary constraint code', () => {
      // `mapResultCode` only yields the extended code for 787; a driver reporting the primary 19
      // arrives as SQLITE_CONSTRAINT, and must still get the specific sentence.
      const error = new DbError('SQLITE_CONSTRAINT', 'FOREIGN KEY constraint failed');
      expect(describeDbError(error)).toEqual({ key: 'db.error.foreignKey' });
    });

    it('keeps an authored sentence thrown under a constraint code', () => {
      // `AttachmentRepository.validateValue` is the good pattern the issue points at: better copy
      // than anything derivable from the code, so humanising must not clobber it.
      const error = new DbError('SQLITE_CONSTRAINT', 'Enter a valid URL (http or https).');
      expect(describeDbError(error)).toBeUndefined();
    });
  });

  it('resolves every key it can emit against the base catalog', () => {
    // The pure module stays catalog-free by design, so `useErrorMessage` casts its keys to
    // `MessageKey`. This is the check that makes the cast safe, and that catches a renamed key.
    const codes: DbErrorCode[] = [
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_FULL',
      'SQLITE_READONLY',
      'WRITE_SUSPENDED',
      'MULTI_TAB_LOCKED',
      'OPFS_UNAVAILABLE',
      'NOT_CROSS_ORIGIN_ISOLATED',
      'SCHEMA_TOO_NEW',
      'SCHEMA_STALE',
      'FTS5_UNAVAILABLE',
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    ];
    const messages = [
      'UNIQUE constraint failed: tags.name',
      'UNIQUE constraint failed: contacts.name',
      'UNIQUE constraint failed: suppliers.name_key',
      'UNIQUE constraint failed: field_defs.name',
      'UNIQUE constraint failed: roles.name',
      'UNIQUE constraint failed: users.username',
      'UNIQUE constraint failed: item_aliases.alias',
      'UNIQUE constraint failed: widgets.code',
      'NOT NULL constraint failed: contacts.name',
      'NOT NULL constraint failed: widgets.code',
      'CHECK constraint failed: qty',
      'constraint failed',
    ];

    const described = [
      // A genuinely raw message, so the constraint codes in the list are not treated as authored.
      ...codes.map((code) => describeDbError(new DbError(code, 'constraint failed'))),
      ...messages.map((m) => describeDbError(new DbError('SQLITE_CONSTRAINT', m))),
    ];

    for (const d of described) {
      expect(d, 'every fixture above should describe').toBeDefined();
      expect(catalog[d!.key], `en["${d!.key}"]`).toBeTypeOf('string');
      if (d!.fieldKey) expect(catalog[d!.fieldKey], `en["${d!.fieldKey}"]`).toBeTypeOf('string');
    }
  });
});

describe('hasAuthoredMessage', () => {
  it('accepts a written sentence and rejects raw SQLite text', () => {
    expect(hasAuthoredMessage(new Error('That project is already archived.'))).toBe(true);
    expect(hasAuthoredMessage(new Error('UNIQUE constraint failed: tags.name'))).toBe(false);
    expect(hasAuthoredMessage(new Error(''))).toBe(false);
    expect(hasAuthoredMessage('a string, not an Error')).toBe(false);
  });
});
