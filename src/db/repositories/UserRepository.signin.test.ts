/**
 * Sign-in and password storage (issue #79, phase 3).
 *
 * The cases that matter most are the ones where a mistake fails *open*: a disabled account
 * getting in, a wrong password being accepted, or the System actor being signed in as.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { hashPassword, PASSWORD_ITERATIONS } from '@/features/users/password';
import { migrations } from '../migrations';
import { runMigrations } from '../migrations/engine';
import { ADMIN_USER_ID, SYSTEM_USER_ID } from './constants';
import { UserRepository } from './UserRepository';

describe('sign-in', () => {
  let driver: MemoryDriver;
  let users: UserRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    users = new UserRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('setting a password', () => {
    it('stores a password that verifies, and never the password itself', async () => {
      const user = await users.create({ username: 'sam' });
      const updated = await users.setPassword(user.id, 'hunter-correct-horse');
      expect(updated.hasPassword).toBe(true);

      const row = await driver.queryOne<{ password_hash: string; password_salt: string }>(
        'SELECT password_hash, password_salt FROM users WHERE id = ?;',
        [user.id],
      );
      expect(row?.password_hash).not.toContain('hunter-correct-horse');
      expect(row?.password_salt).not.toContain('hunter-correct-horse');
    });

    it('clears a password back to none, which is a legitimate end state', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'something');
      const cleared = await users.clearPassword(user.id);
      expect(cleared.hasPassword).toBe(false);

      // All three columns go together — the row's CHECK would reject anything else.
      const row = await driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users
         WHERE id = ? AND password_hash IS NULL AND password_salt IS NULL AND password_iterations IS NULL;`,
        [user.id],
      );
      expect(row?.n).toBe(1);
    });

    it('lets the built-in Admin take a password, unlike every other edit', async () => {
      // With the module on, Admin is a real account someone signs in as; a full-access account
      // that could not be protected would be worse than no sign-in at all.
      const admin = await users.setPassword(ADMIN_USER_ID, 'admin-password');
      expect(admin.hasPassword).toBe(true);
      const outcome = await users.verifySignIn(ADMIN_USER_ID, 'admin-password');
      expect(outcome.ok).toBe(true);
    });

    it('still refuses to rename, disable or re-role Admin — at the database, not just in code', async () => {
      await expect(
        driver.execute('UPDATE users SET username = ? WHERE id = ?;', ['root', ADMIN_USER_ID]),
      ).rejects.toThrow(/cannot be renamed, disabled or re-roled/i);
      await expect(
        driver.execute('UPDATE users SET is_enabled = 0 WHERE id = ?;', [ADMIN_USER_ID]),
      ).rejects.toThrow(/cannot be renamed, disabled or re-roled/i);
      await expect(
        driver.execute('UPDATE users SET display_name = ? WHERE id = ?;', ['Root', ADMIN_USER_ID]),
      ).rejects.toThrow(/cannot be renamed, disabled or re-roled/i);
    });

    it('refuses a password on System, at both layers', async () => {
      await expect(users.setPassword(SYSTEM_USER_ID, 'nope')).rejects.toThrow(/actor rather than a person/i);
      await expect(
        driver.execute('UPDATE users SET password_hash = ? WHERE id = ?;', ['x', SYSTEM_USER_ID]),
      ).rejects.toThrow(/cannot be modified/i);
    });
  });

  describe('verifying a sign-in', () => {
    it('accepts the right password', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'right');

      const outcome = await users.verifySignIn(user.id, 'right');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.user.username).toBe('sam');
    });

    it('rejects the wrong password', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'right');
      expect(await users.verifySignIn(user.id, 'wrong')).toEqual({ ok: false, reason: 'wrong-password' });
      expect(await users.verifySignIn(user.id, '')).toEqual({ ok: false, reason: 'wrong-password' });
    });

    it('lets a user with no password in, since that is a supported configuration', async () => {
      const user = await users.create({ username: 'sam' });
      const outcome = await users.verifySignIn(user.id, '');
      expect(outcome.ok).toBe(true);
    });

    it('refuses a disabled user and carries the administrator’s message back', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'right');
      await users.update(user.id, { isEnabled: false, disabledMessage: 'On leave until March.' });

      // Refused even with the correct password — being disabled outranks knowing it.
      expect(await users.verifySignIn(user.id, 'right')).toEqual({
        ok: false,
        reason: 'disabled',
        disabledMessage: 'On leave until March.',
      });
    });

    it('never signs in as System, which is an actor rather than a person', async () => {
      expect(await users.verifySignIn(SYSTEM_USER_ID, '')).toEqual({ ok: false, reason: 'unknown-user' });
    });

    it('reports an account that no longer exists', async () => {
      expect(await users.verifySignIn('00000000-0000-4000-8000-00000000dead', '')).toEqual({
        ok: false,
        reason: 'unknown-user',
      });
    });

    it('upgrades a password hashed at a weaker setting, on the one occasion it can', async () => {
      const user = await users.create({ username: 'sam' });
      // A credential exactly as an older, weaker build would have written it — hash and
      // iteration count consistent with each other, just low.
      const legacy = await hashPassword('legacy', 1_000);
      await driver.execute(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?;`,
        [legacy.hash, legacy.salt, legacy.iterations, user.id],
      );

      const outcome = await users.verifySignIn(user.id, 'legacy');
      expect(outcome.ok).toBe(true);

      // Signing in is the only moment the plaintext is in hand, so it is the only moment the
      // stored hash can be strengthened — and it must have been.
      const after = await driver.queryOne<{ password_hash: string; password_iterations: number }>(
        'SELECT password_hash, password_iterations FROM users WHERE id = ?;',
        [user.id],
      );
      expect(after?.password_iterations).toBe(PASSWORD_ITERATIONS);
      expect(after?.password_hash).not.toBe(legacy.hash);

      // …and the same password still works against the upgraded credential.
      expect((await users.verifySignIn(user.id, 'legacy')).ok).toBe(true);
    }, 30_000);

    it('leaves a current credential alone rather than rewriting it on every sign-in', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'current');
      const before = await driver.queryOne<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?;',
        [user.id],
      );

      expect((await users.verifySignIn(user.id, 'current')).ok).toBe(true);

      const after = await driver.queryOne<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?;',
        [user.id],
      );
      expect(after?.password_hash).toBe(before?.password_hash);
    }, 30_000);
  });

  describe('the accounts offered on the sign-in screen', () => {
    it('excludes System but includes Admin', async () => {
      const candidates = await users.listSignInCandidates();
      expect(candidates.map((u) => u.id)).toEqual([ADMIN_USER_ID]);
    });

    it('includes disabled users, so they can be told why they cannot sign in', async () => {
      const user = await users.create({ username: 'sam', displayName: 'Sam' });
      await users.update(user.id, { isEnabled: false, disabledMessage: 'On leave.' });

      const candidates = await users.listSignInCandidates();
      const sam = candidates.find((u) => u.id === user.id);
      expect(sam).toBeDefined();
      expect(sam?.isEnabled).toBe(false);
      expect(sam?.disabledMessage).toBe('On leave.');
    });

    it('never exposes a password hash on the accounts it lists', async () => {
      const user = await users.create({ username: 'sam' });
      await users.setPassword(user.id, 'secret-value-abc');

      const candidates = await users.listSignInCandidates();
      expect(JSON.stringify(candidates)).not.toContain('secret-value-abc');
      expect(candidates.find((u) => u.id === user.id)?.hasPassword).toBe(true);
    });
  });
});
