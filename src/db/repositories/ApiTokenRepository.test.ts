/**
 * Bridge API token storage (issue #79, plan §1.3).
 *
 * The assertions here are mostly about what is *not* stored and what stops working when a token
 * or its owner goes away — the properties a credential store lives or dies by, and the ones a
 * shape-only test would sail straight past.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { hashApiToken } from '@/features/users/api-token';
import { runMigrations } from '../migrations/engine';
import { migrations } from '../migrations';
import { ADMIN_USER_ID } from './constants';
import { ApiTokenRepository, MAX_API_TOKEN_NAME_LENGTH } from './ApiTokenRepository';
import { TombstoneRepository } from './tombstone';
import { UserRepository } from './UserRepository';

describe('ApiTokenRepository', () => {
  let driver: MemoryDriver;
  let tokens: ApiTokenRepository;
  let users: UserRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    tokens = new ApiTokenRepository(driver);
    users = new UserRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('minting', () => {
    it('returns the plaintext once and stores only its hash', async () => {
      const { apiToken, token } = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Home Assistant' });

      expect(apiToken.name).toBe('Home Assistant');
      expect(apiToken.userId).toBe(ADMIN_USER_ID);
      // The DTO carries no hash at all, so nothing downstream can leak one.
      expect(apiToken).not.toHaveProperty('tokenHash');
      expect(JSON.stringify(apiToken)).not.toContain(token);

      const row = await driver.queryOne<{ token_hash: string }>(
        'SELECT token_hash FROM api_tokens WHERE id = ?;',
        [apiToken.id],
      );
      expect(row!.token_hash).toBe(await hashApiToken(token));
      expect(row!.token_hash).not.toBe(token);
    });

    it('records the non-secret prefix for display', async () => {
      const { apiToken, token } = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Kitchen tablet' });
      expect(token.startsWith(apiToken.tokenPrefix)).toBe(true);
      expect(apiToken.tokenPrefix.length).toBeLessThan(token.length);
    });

    it('mints a distinct token each time, even for the same name', async () => {
      const first = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Same' });
      const second = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Same' });
      expect(first.token).not.toBe(second.token);
      expect(await tokens.resolveUserId(first.token)).toBe(ADMIN_USER_ID);
      expect(await tokens.resolveUserId(second.token)).toBe(ADMIN_USER_ID);
    });

    it('rejects a blank or over-long name', async () => {
      await expect(tokens.mint({ userId: ADMIN_USER_ID, name: '   ' })).rejects.toThrow(/name/i);
      await expect(
        tokens.mint({ userId: ADMIN_USER_ID, name: 'x'.repeat(MAX_API_TOKEN_NAME_LENGTH + 1) }),
      ).rejects.toThrow(/at most/i);
    });
  });

  describe('resolving', () => {
    it('resolves a live token to its owner, and anything else to undefined', async () => {
      const { token } = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Dashboard' });
      expect(await tokens.resolveUserId(token)).toBe(ADMIN_USER_ID);
      expect(await tokens.resolveUserId('gbn_not-a-real-token')).toBeUndefined();
      expect(await tokens.resolveUserId('')).toBeUndefined();
      expect(await tokens.resolveUserId('   ')).toBeUndefined();
    });

    it('tolerates whitespace around a pasted token', async () => {
      const { token } = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Pasted' });
      expect(await tokens.resolveUserId(`  ${token}\n`)).toBe(ADMIN_USER_ID);
    });
  });

  describe('revocation', () => {
    it('stops the token resolving, and records a tombstone so it syncs', async () => {
      const { apiToken, token } = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Old laptop' });
      await tokens.revoke(apiToken.id);

      expect(await tokens.resolveUserId(token)).toBeUndefined();
      expect(await tokens.getById(apiToken.id)).toBeUndefined();
      // A hard delete rather than a flag: there is no row left for a consumer to mis-read.
      expect(await tombstones.has('api_tokens', apiToken.id)).toBe(true);
    });

    it('refuses to revoke a token that is already gone', async () => {
      await expect(tokens.revoke('no-such-token')).rejects.toThrow(/no longer exists/i);
    });
  });

  describe('lifetime', () => {
    it('lists a user’s tokens newest first', async () => {
      const first = await tokens.mint({ userId: ADMIN_USER_ID, name: 'First' });
      await driver.execute('UPDATE api_tokens SET created_at = 1 WHERE id = ?;', [first.apiToken.id]);
      const second = await tokens.mint({ userId: ADMIN_USER_ID, name: 'Second' });

      const listed = await tokens.listByUser(ADMIN_USER_ID);
      expect(listed.map((t) => t.id)).toEqual([second.apiToken.id, first.apiToken.id]);
    });

    // A credential must not outlive the account it speaks for — unlike history, which is
    // re-attributed to System rather than deleted.
    it('dies with its owner', async () => {
      const owner = await users.create({ username: 'sam', displayName: 'Sam Okafor' });
      const { token, apiToken } = await tokens.mint({ userId: owner.id, name: 'Sam’s script' });
      expect(await tokens.resolveUserId(token)).toBe(owner.id);

      await users.delete(owner.id);

      expect(await tokens.getById(apiToken.id)).toBeUndefined();
      expect(await tokens.resolveUserId(token)).toBeUndefined();
    });
  });
});
