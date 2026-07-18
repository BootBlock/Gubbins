/**
 * Users, roles and actor attribution (issue #79, phase 1).
 *
 * The built-in-principal guards are asserted at **both** layers deliberately: the repository
 * produces a legible error, and the SQL trigger is what holds when a write reaches SQLite by
 * some other route. Testing only the repository would leave the trigger — the actual guard —
 * unverified.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '../migrations/engine';
import { migrations } from '../migrations';
import { ADMIN_USER_ID, SYSTEM_USER_ID, UNASSIGNED_LOCATION_ID } from './constants';
import { ItemRepository } from './ItemRepository';
import { RoleRepository } from './RoleRepository';
import { TombstoneRepository } from './tombstone';
import { UserRepository } from './UserRepository';

describe('users, roles and attribution', () => {
  let driver: MemoryDriver;
  let users: UserRepository;
  let roles: RoleRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    users = new UserRepository(driver);
    roles = new RoleRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('the built-in principals', () => {
    it('seeds exactly System and Admin, and neither carries a password', async () => {
      const page = await users.list();
      expect(page.rows.map((u) => u.kind)).toEqual(['system', 'admin']);
      expect(page.rows.map((u) => u.id)).toEqual([SYSTEM_USER_ID, ADMIN_USER_ID]);
      expect(page.rows.every((u) => !u.hasPassword)).toBe(true);
      // System never signs in; Admin is the identity single-user mode acts as.
      expect(page.rows.map((u) => u.isEnabled)).toEqual([false, true]);
    });

    it('never exposes the password triple on the DTO, only whether one is set', async () => {
      const user = await users.create({ username: 'sam' });
      await driver.execute(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?;`,
        ['hash-not-a-real-digest', 'salt-value', 210000, user.id],
      );

      const loaded = (await users.getById(user.id))!;
      expect(loaded.hasPassword).toBe(true);
      // The hash and salt must not be able to leak through a stringified user — the DTO has
      // no field for them at all, so nothing downstream can log or export one.
      const serialised = JSON.stringify(loaded);
      expect(serialised).not.toContain('hash-not-a-real-digest');
      expect(serialised).not.toContain('salt-value');
      expect(Object.keys(loaded)).not.toContain('password_hash');
    });

    it.each([
      ['System', SYSTEM_USER_ID],
      ['Admin', ADMIN_USER_ID],
    ])('refuses to delete or disable %s at the repository layer', async (_name, id) => {
      await expect(users.delete(id)).rejects.toThrow(/cannot be deleted/i);
      await expect(users.update(id, { isEnabled: false })).rejects.toThrow(/cannot be modified/i);
    });

    it.each([
      ['System', SYSTEM_USER_ID],
      ['Admin', ADMIN_USER_ID],
    ])('refuses to delete or disable %s at the SQL layer too', async (_name, id) => {
      // Bypassing the repository entirely — this is the guard that actually holds.
      await expect(driver.execute('DELETE FROM users WHERE id = ?;', [id])).rejects.toThrow(
        /cannot be deleted/i,
      );
      await expect(driver.execute('UPDATE users SET is_enabled = 0 WHERE id = ?;', [id])).rejects.toThrow(
        /cannot be modified/i,
      );
    });
  });

  describe('ordinary users', () => {
    it('creates, renames and deletes, recording a tombstone so the deletion syncs', async () => {
      const user = await users.create({ username: '  sam  ', email: ' sam@example.com ' });
      expect(user).toMatchObject({
        username: 'sam',
        displayName: 'sam',
        email: 'sam@example.com',
        kind: 'normal',
        isEnabled: true,
        hasPassword: false,
      });

      const renamed = await users.update(user.id, { displayName: 'Sam Carter' });
      expect(renamed.displayName).toBe('Sam Carter');

      await users.delete(user.id);
      expect(await users.getById(user.id)).toBeUndefined();
      const page = await tombstones.list();
      expect(page.rows.some((t) => t.tableName === 'users' && t.id === user.id)).toBe(true);
    });

    it('rejects a duplicate username case-insensitively', async () => {
      await users.create({ username: 'sam' });
      await expect(users.create({ username: 'SAM' })).rejects.toThrow();
    });

    it('keeps the account when its role is deleted, clearing only the grant', async () => {
      const role = await roles.create({ name: 'Stocker', permissions: ['items:write'] });
      const user = await users.create({ username: 'sam', roleId: role.id });
      expect((await users.getById(user.id))!.roleId).toBe(role.id);

      await roles.delete(role.id);

      // Deleting a role must never delete a person.
      const after = (await users.getById(user.id))!;
      expect(after.roleId).toBeNull();
    });
  });

  describe('roles', () => {
    it('round-trips permissions through storage', async () => {
      const role = await roles.create({ name: 'Viewer', permissions: ['items:read', 'audit:view'] });
      expect((await roles.getById(role.id))!.permissions).toEqual(['items:read', 'audit:view']);
    });

    it('degrades an unparseable permissions column to no permissions', async () => {
      const role = await roles.create({ name: 'Broken' });
      await driver.execute('UPDATE roles SET permissions = ? WHERE id = ?;', ['not json', role.id]);
      // A role that fails to load must not be able to grant anything.
      expect((await roles.getById(role.id))!.permissions).toEqual([]);
    });

    it('refuses to delete a built-in role at both layers', async () => {
      const role = await roles.create({ name: 'Manager' });
      await driver.execute('UPDATE roles SET is_builtin = 1 WHERE id = ?;', [role.id]);

      await expect(roles.delete(role.id)).rejects.toThrow(/cannot be deleted/i);
      await expect(driver.execute('DELETE FROM roles WHERE id = ?;', [role.id])).rejects.toThrow(
        /cannot be deleted/i,
      );
    });
  });

  describe('actor attribution on the ledger', () => {
    async function seedItem(repo: ItemRepository): Promise<string> {
      const item = await repo.create({ name: 'Cordless drill', locationId: UNASSIGNED_LOCATION_ID });
      return item.id;
    }

    async function actorsFor(itemId: string): Promise<string[]> {
      const rows = await driver.query<{ actor_user_id: string }>(
        'SELECT actor_user_id FROM item_history WHERE item_id = ? ORDER BY created_at ASC;',
        [itemId],
      );
      return rows.map((r) => r.actor_user_id);
    }

    it('attributes writes to Admin by default, matching single-user mode', async () => {
      const items = new ItemRepository(driver);
      const id = await seedItem(items);
      await items.adjustQuantity(id, 5);
      expect(await actorsFor(id)).toEqual([ADMIN_USER_ID, ADMIN_USER_ID]);
    });

    it('attributes writes to whoever the resolver names', async () => {
      const sam = await users.create({ username: 'sam' });
      const items = new ItemRepository(driver, { resolveActor: () => sam.id });
      const id = await seedItem(items);
      expect(await actorsFor(id)).toEqual([sam.id]);
    });

    it('follows the resolver as the signed-in user changes, without rebuilding the repository', async () => {
      const sam = await users.create({ username: 'sam' });
      let current = ADMIN_USER_ID;
      const items = new ItemRepository(driver, { resolveActor: () => current });
      const id = await seedItem(items);
      current = sam.id;
      await items.adjustQuantity(id, 2);
      expect(await actorsFor(id)).toEqual([ADMIN_USER_ID, sam.id]);
    });

    it("re-attributes a deleted user's entries to System instead of destroying them", async () => {
      const sam = await users.create({ username: 'sam' });
      const items = new ItemRepository(driver, { resolveActor: () => sam.id });
      const id = await seedItem(items);
      await items.adjustQuantity(id, 3);
      expect(await actorsFor(id)).toEqual([sam.id, sam.id]);

      await users.delete(sam.id);

      // The ledger survives the account; only the attribution moves.
      expect(await actorsFor(id)).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID]);
    });

    it('keeps the ledger immutable in substance', async () => {
      const items = new ItemRepository(driver);
      const id = await seedItem(items);
      await expect(
        driver.execute('UPDATE item_history SET action = ? WHERE item_id = ?;', ['FORGED', id]),
      ).rejects.toThrow(/immutable, append-only ledger/i);
      await expect(
        driver.execute('UPDATE item_history SET note = ? WHERE item_id = ?;', ['rewritten', id]),
      ).rejects.toThrow(/immutable, append-only ledger/i);
    });
  });
});
