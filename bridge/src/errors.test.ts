/**
 * The two error-describing variants. The cases that matter are the non-`Error` throws — a string,
 * `undefined`, a plain object — because those are exactly what the inline ternaries this module
 * replaced were there to survive.
 */
import { describe, expect, it } from 'vitest';
import { errorDetail, errorMessage } from './errors.ts';

describe('errorMessage', () => {
  it('takes the message from an Error', () => {
    expect(errorMessage(new Error('could not read the snapshot'))).toBe('could not read the snapshot');
  });

  it('stringifies anything that is not an Error', () => {
    expect(errorMessage('a bare string')).toBe('a bare string');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(42)).toBe('42');
  });

  it('leaves the errno code out — it is for messages a user reads', () => {
    const err: NodeJS.ErrnoException = new Error('no such file or directory');
    err.code = 'ENOENT';
    expect(errorMessage(err)).toBe('no such file or directory');
  });
});

describe('errorDetail', () => {
  it('appends the errno code when there is one', () => {
    const err: NodeJS.ErrnoException = new Error('too many open files');
    err.code = 'EMFILE';
    expect(errorDetail(err)).toBe('too many open files (EMFILE)');
  });

  it('matches errorMessage when there is no code to add', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail('just a string')).toBe('just a string');
    expect(errorDetail(undefined)).toBe('undefined');
  });
});
