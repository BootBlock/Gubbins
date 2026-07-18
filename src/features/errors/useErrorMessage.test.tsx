import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DbError } from '@/db/errors';
import { useErrorMessage } from './useErrorMessage';

/**
 * The precedence rule, end to end through the real catalog: humanised sentence → the error's own
 * authored message → the call site's fallback. The old idiom got this exactly backwards, so each
 * rung is asserted rather than just the happy path.
 */
describe('useErrorMessage', () => {
  const resolve = (error: unknown, fallback = 'Could not save this change.'): string => {
    const { result } = renderHook(() => useErrorMessage());
    return result.current(error, fallback);
  };

  it('humanises a raw UNIQUE violation, naming the field', () => {
    const error = new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed: contacts.name');
    expect(resolve(error)).toBe('That contact name is already in use. Choose a different one.');
  });

  it('humanises a raw UNIQUE violation on an unmapped column generically', () => {
    const error = new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed: widgets.code');
    expect(resolve(error)).toBe('Something with those details already exists. Change them and try again.');
  });

  it('reads grammatically for every field noun it can name', () => {
    // "A {field} is required" would produce "A alias is required"; the wording must survive every
    // noun in the closed field map, not just the one the first test happened to use.
    const required = (column: string): string =>
      resolve(new DbError('SQLITE_CONSTRAINT', `NOT NULL constraint failed: ${column}`));
    expect(required('item_aliases.alias')).toBe('A value is required for the alias.');
    expect(required('users.username')).toBe('A value is required for the username.');
  });

  it('explains the storage hard stop instead of surfacing its jargon', () => {
    const error = new DbError('WRITE_SUSPENDED', 'Storage is full (Hard Stop): new writes are suspended.');
    expect(resolve(error)).toBe(
      'Saving is paused because storage is nearly full. Free up space on this device to continue.',
    );
  });

  it("keeps a repository's authored sentence", () => {
    const error = new DbError('SQLITE_CONSTRAINT', 'Enter a valid URL (http or https).');
    expect(resolve(error)).toBe('Enter a valid URL (http or https).');
  });

  it('keeps a plain Error whose message was written for a human', () => {
    expect(resolve(new Error('That project is already archived.'))).toBe('That project is already archived.');
  });

  it('falls back to the call site copy for raw text it cannot classify', () => {
    // A non-DbError carrying SQLite text: nothing to humanise from, but it must not reach the user.
    expect(resolve(new Error('no such column: items.wibble'))).toBe('Could not save this change.');
  });

  it('falls back to the call site copy for a non-Error throw', () => {
    expect(resolve('boom')).toBe('Could not save this change.');
    expect(resolve(undefined)).toBe('Could not save this change.');
  });
});
