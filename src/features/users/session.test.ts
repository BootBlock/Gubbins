/**
 * Session reconciliation tests (issue #79, plan §3).
 *
 * This runs over whatever was last written to this device's localStorage by any version of
 * Gubbins — and, since a device can edit its own storage, over whatever its owner chose to put
 * there. The cases below are therefore about failing closed, not about tolerance.
 */
import { describe, expect, it } from 'vitest';
import { normaliseSession } from './session';

const VALID = { userId: 'u1', displayName: 'Sam', signedInAt: 1_700_000_000_000 };

describe('normaliseSession', () => {
  it('keeps a well-formed session', () => {
    expect(normaliseSession(VALID)).toEqual(VALID);
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 'corrupt', 42, [], true]) {
      expect(normaliseSession(value)).toBeNull();
    }
  });

  it('rejects a session with no usable user id', () => {
    // Partial recovery is deliberately not attempted: a session without a user is not a
    // session, and inventing one would sign somebody in as nobody.
    expect(normaliseSession({ ...VALID, userId: '' })).toBeNull();
    expect(normaliseSession({ ...VALID, userId: '   ' })).toBeNull();
    expect(normaliseSession({ ...VALID, userId: 42 })).toBeNull();
    expect(normaliseSession({ displayName: 'Sam' })).toBeNull();
  });

  it('rejects a session with no usable display name', () => {
    expect(normaliseSession({ ...VALID, displayName: '' })).toBeNull();
    expect(normaliseSession({ ...VALID, displayName: null })).toBeNull();
  });

  it('repairs an implausible timestamp rather than discarding the session', () => {
    // The timestamp is a label, not a credential, so a bad one is not grounds to sign the user
    // out — unlike the identity fields above.
    expect(normaliseSession({ ...VALID, signedInAt: -1 })?.signedInAt).toBe(0);
    expect(normaliseSession({ ...VALID, signedInAt: 'yesterday' })?.signedInAt).toBe(0);
    expect(normaliseSession({ ...VALID, signedInAt: undefined })?.signedInAt).toBe(0);
  });

  it('ignores extra fields, including any that would claim permissions', () => {
    // Nothing about authority is ever read from storage: a device editing its own localStorage
    // must not be able to award itself a role or a set of grants.
    const tampered = { ...VALID, roleId: 'administrator', permissions: ['*'], kind: 'admin' };
    expect(normaliseSession(tampered)).toEqual(VALID);
  });
});
