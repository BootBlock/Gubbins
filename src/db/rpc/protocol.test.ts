/**
 * Issue #354: the response-envelope guard narrows a discriminated union, so it has to prove the
 * arm it selects — an `ok: false` envelope without a well-formed `SerializedDbError` would
 * otherwise reach `DbError.fromSerialized` and fail inside the driver's rejection path.
 */
import { describe, expect, it } from 'vitest';
import { isRpcResponseEnvelope } from './protocol';
import { DbError } from '../errors';

const serializedError = new DbError('SQLITE_BUSY', 'database is locked').toSerialized();

describe('isRpcResponseEnvelope', () => {
  it('accepts a success envelope, including one whose result is undefined', () => {
    expect(isRpcResponseEnvelope({ id: 'a', ok: true, result: [{ n: 1 }] })).toBe(true);
    // `transaction`/`close` answer with a null result, and `undefined` survives structured clone.
    expect(isRpcResponseEnvelope({ id: 'a', ok: true, result: null })).toBe(true);
    expect(isRpcResponseEnvelope({ id: 'a', ok: true, result: undefined })).toBe(true);
  });

  it('accepts a failure envelope carrying a serialised DbError', () => {
    expect(isRpcResponseEnvelope({ id: 'a', ok: false, error: serializedError })).toBe(true);
  });

  it('rejects a success envelope with no result property at all', () => {
    expect(isRpcResponseEnvelope({ id: 'a', ok: true })).toBe(false);
  });

  it('rejects a failure envelope whose error is missing or malformed', () => {
    expect(isRpcResponseEnvelope({ id: 'a', ok: false })).toBe(false);
    expect(isRpcResponseEnvelope({ id: 'a', ok: false, error: null })).toBe(false);
    expect(isRpcResponseEnvelope({ id: 'a', ok: false, error: 'boom' })).toBe(false);
    expect(isRpcResponseEnvelope({ id: 'a', ok: false, error: { name: 'DbError' } })).toBe(false);
    expect(
      isRpcResponseEnvelope({
        id: 'a',
        ok: false,
        error: { name: 'DbError', code: 'NOT_A_CODE', message: 'x' },
      }),
    ).toBe(false);
  });

  it('rejects anything that is not an envelope', () => {
    expect(isRpcResponseEnvelope(null)).toBe(false);
    expect(isRpcResponseEnvelope(undefined)).toBe(false);
    expect(isRpcResponseEnvelope('ok')).toBe(false);
    expect(isRpcResponseEnvelope({ ok: true, result: 1 })).toBe(false);
    expect(isRpcResponseEnvelope({ id: 1, ok: true, result: 1 })).toBe(false);
    // Truthy is not `true`: only the literal discriminants select an arm.
    expect(isRpcResponseEnvelope({ id: 'a', ok: 'true', result: 1 })).toBe(false);
  });
});
