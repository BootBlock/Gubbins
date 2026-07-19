/**
 * Password hashing tests (issue #79, plan §1.1).
 *
 * The iteration count is lowered throughout: these assert the *shape* of the scheme, and
 * 600,000 rounds per case would make the suite slow without testing anything extra. The one
 * place the real constant matters — whether a stale hash is detected for upgrade — is asserted
 * against the constant itself rather than a copy of its value.
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword, PASSWORD_ITERATIONS } from './password';

const FAST = 1_000;

describe('hashPassword', () => {
  it('produces a verifiable credential', async () => {
    const credential = await hashPassword('correct horse', FAST);
    expect(await verifyPassword('correct horse', credential)).toBe(true);
  });

  it('never stores the password itself', async () => {
    const credential = await hashPassword('correct horse', FAST);
    expect(credential.hash).not.toContain('correct horse');
    expect(credential.salt).not.toContain('correct horse');
  });

  it('salts each credential separately, so identical passwords do not share a hash', async () => {
    const a = await hashPassword('same', FAST);
    const b = await hashPassword('same', FAST);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.hash).not.toEqual(b.hash);
  });

  it('records the iteration count it actually used', async () => {
    expect((await hashPassword('x', FAST)).iterations).toBe(FAST);
    // …and defaults to the current constant when not told otherwise.
    expect((await hashPassword('x')).iterations).toBe(PASSWORD_ITERATIONS);
  }, 20_000);

  it('refuses an empty password rather than hashing one', async () => {
    // "No password" is the absence of a credential, never a hash of ''. Two encodings of the
    // same state would mean the weaker one silently satisfies a password prompt.
    await expect(hashPassword('', FAST)).rejects.toThrow(/cannot be empty/i);
  });
});

describe('verifyPassword', () => {
  it('rejects the wrong password', async () => {
    const credential = await hashPassword('correct horse', FAST);
    expect(await verifyPassword('correct horsé', credential)).toBe(false);
    expect(await verifyPassword('Correct horse', credential)).toBe(false);
    expect(await verifyPassword('', credential)).toBe(false);
  });

  it('verifies at the credential’s own iteration count, not the current one', async () => {
    // This is what lets the count be raised without invalidating every existing password.
    const old = await hashPassword('legacy', 1_000);
    expect(await verifyPassword('legacy', old)).toBe(true);
  });

  it('fails closed on a corrupt credential rather than throwing', async () => {
    const credential = await hashPassword('x', FAST);
    expect(await verifyPassword('x', { ...credential, salt: 'not base64 !!!' })).toBe(false);
    expect(await verifyPassword('x', { ...credential, hash: 'wrong-length' })).toBe(false);
    expect(await verifyPassword('x', { ...credential, iterations: 0 })).toBe(false);
    expect(await verifyPassword('x', { ...credential, iterations: -1 })).toBe(false);
    expect(await verifyPassword('x', { ...credential, iterations: 1.5 })).toBe(false);
  });
});

describe('needsRehash', () => {
  it('flags a credential weaker than the current standard', async () => {
    expect(needsRehash(await hashPassword('x', FAST))).toBe(true);
  });

  it('leaves a current credential alone', () => {
    expect(needsRehash({ hash: 'h', salt: 's', iterations: PASSWORD_ITERATIONS })).toBe(false);
  });
});
