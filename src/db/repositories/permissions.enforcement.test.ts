/**
 * Repository-level permission enforcement (issue #79, phase 2, plan §2.3).
 *
 * The engine's own tests prove `can()` answers correctly; these prove the repository layer
 * actually *asks* — and asks with the right key. That distinction matters, because every
 * guard in the layer is inert today (production resolves to an unrestricted authority until
 * phase 3 introduces a session), so a missing or mis-keyed guard would otherwise show up as
 * nothing at all until the moment it starts protecting real data.
 *
 * The default-unrestricted case is asserted first and deliberately: getting that wrong fails
 * *open* in the other direction — it would break single-user mode, which is every existing
 * install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '../errors';
import { migrations } from '../migrations';
import { runMigrations } from '../migrations/engine';
import type { Authority } from '@/features/users/permissions';
import { BUILTIN_ROLES } from '@/features/users/builtin-roles';
import { can, resolveAuthority } from '@/features/users/permissions';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { UNASSIGNED_LOCATION_ID } from './constants';
import type { RepositoryOptions } from './base';
import { UserRepository } from './UserRepository';

/** Options wiring a fixed authority in, standing in for phase 3's session lookup. */
const withAuthority = (authority: Authority): RepositoryOptions => ({ resolveAuthority: () => authority });

/** The authority an enabled, ordinary user holding the named built-in role resolves to. */
function asRole(name: string): Authority {
  const role = BUILTIN_ROLES.find((candidate) => candidate.name === name)!;
  return resolveAuthority({
    moduleEnabled: true,
    user: { id: 'u1', kind: 'normal', isEnabled: true },
    grants: role.grants,
  });
}

const DENIED: Authority = { mode: 'denied', reason: 'signed-out' };

/** Assert `run()` is refused as a permission problem naming `key`, not some other failure. */
async function expectDenied(run: () => Promise<unknown>, key: string): Promise<void> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('PERMISSION_DENIED');
  expect((error as DbError).message).toContain(key);
}

describe('repository permission enforcement', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('with no authority wired (single-user mode, and every test fixture)', () => {
    it('permits writes exactly as before permissions existed', async () => {
      const items = new ItemRepository(driver);
      const item = await items.create({ name: 'Brass washer', locationId: UNASSIGNED_LOCATION_ID });
      expect(item.name).toBe('Brass washer');
      await expect(items.update(item.id, { name: 'Steel washer' })).resolves.toBeDefined();
      await expect(items.softDelete(item.id)).resolves.not.toThrow();
    });
  });

  describe('with a denied authority', () => {
    it('refuses to create, edit or delete an item', async () => {
      const items = new ItemRepository(driver, withAuthority(DENIED));
      await expectDenied(
        () => items.create({ name: 'Nope', locationId: UNASSIGNED_LOCATION_ID }),
        'items:write',
      );
      await expectDenied(() => items.update('any-id', { name: 'Nope' }), 'items:write');
      await expectDenied(() => items.softDelete('any-id'), 'items:delete');
    });

    it('refuses before touching the database, so nothing is half-written', async () => {
      const items = new ItemRepository(driver, withAuthority(DENIED));
      await expectDenied(
        () => items.create({ name: 'Nope', locationId: UNASSIGNED_LOCATION_ID }),
        'items:write',
      );
      const remaining = await driver.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM items;');
      expect(remaining?.count).toBe(0);
    });

    /**
     * The repository layer gates writes and lets reads through, deliberately: gating every list
     * and search query would put a permission check in the hot path of every screen. Read access
     * is decided one level up, at the screen boundary — see `PermissionGuard` (issue #522) — and
     * on the bridge, which checks the read key on every request. Anything reading straight from
     * a repository (sync, restore, the importer) is unrestricted here by design.
     */
    it('leaves reads alone — the repository layer gates writes only', async () => {
      const seed = new ItemRepository(driver);
      const item = await seed.create({ name: 'Readable', locationId: UNASSIGNED_LOCATION_ID });

      const items = new ItemRepository(driver, withAuthority(DENIED));
      await expect(items.getById(item.id)).resolves.toMatchObject({ name: 'Readable' });
    });
  });

  describe('with a Stocker authority', () => {
    it('permits creating and editing an item', async () => {
      const items = new ItemRepository(driver, withAuthority(asRole('Stocker')));
      const item = await items.create({ name: 'Copper pipe', locationId: UNASSIGNED_LOCATION_ID });
      await expect(items.update(item.id, { name: 'Copper pipe 15mm' })).resolves.toBeDefined();
    });

    it('refuses to delete one — the distinction the role exists to draw', async () => {
      const seed = new ItemRepository(driver);
      const item = await seed.create({ name: 'Copper pipe', locationId: UNASSIGNED_LOCATION_ID });

      const items = new ItemRepository(driver, withAuthority(asRole('Stocker')));
      await expectDenied(() => items.softDelete(item.id), 'items:delete');
      await expectDenied(() => items.hardDelete(item.id), 'items:delete');
    });

    it('refuses to manage accounts', async () => {
      const users = new UserRepository(driver, withAuthority(asRole('Stocker')));
      await expectDenied(() => users.create({ username: 'intruder' }), 'users:manage');
    });
  });

  describe('with a Viewer authority', () => {
    it('refuses every kind of write, across repositories', async () => {
      const authority = withAuthority(asRole('Viewer'));
      const items = new ItemRepository(driver, authority);
      const locations = new LocationRepository(driver, authority);
      const users = new UserRepository(driver, authority);

      await expectDenied(
        () => items.create({ name: 'Nope', locationId: UNASSIGNED_LOCATION_ID }),
        'items:write',
      );
      await expectDenied(() => locations.create({ name: 'Nope' }), 'locations:write');
      await expectDenied(() => users.create({ username: 'nope' }), 'users:manage');
    });
  });

  describe('with an Administrator authority', () => {
    it('permits everything, including account administration', async () => {
      const authority = withAuthority(asRole('Administrator'));
      const items = new ItemRepository(driver, authority);
      const users = new UserRepository(driver, authority);

      const item = await items.create({ name: 'Anything', locationId: UNASSIGNED_LOCATION_ID });
      await expect(items.hardDelete(item.id)).resolves.not.toThrow();
      await expect(users.create({ username: 'sam' })).resolves.toMatchObject({ username: 'sam' });
    });
  });

  describe('a permission never transitively demands another subject', () => {
    // A repository that privately constructs another to do part of its own job runs that
    // collaborator unrestricted: the public method has already been authorised. Passing the
    // caller's authority down instead would make `checkouts:write` secretly also require
    // `contacts:write`, refusing a role the very action it was granted.
    it('lets a Stocker check an item out to a borrower who does not exist yet', async () => {
      const seed = new ItemRepository(driver);
      const item = await seed.create({
        name: 'Cordless drill',
        locationId: UNASSIGNED_LOCATION_ID,
        quantity: 1,
      });

      const stocker = asRole('Stocker');
      expect(can(stocker, 'checkouts:write')).toBe(true);
      // The role deliberately does *not* grant this, which is the whole point of the case.
      expect(can(stocker, 'contacts:write')).toBe(false);

      const checkouts = new CheckoutRepository(driver, withAuthority(stocker));
      await expect(
        checkouts.checkout({ itemId: item.id, quantity: 1, contactName: 'Ada' }),
      ).resolves.toBeDefined();
    });

    it('still refuses the borrower repository when reached directly', async () => {
      // The collaborator exemption must not become a way to launder a write: creating a
      // contact as its own action is still `contacts:write`.
      const contacts = new ContactRepository(driver, withAuthority(asRole('Stocker')));
      await expectDenied(() => contacts.create({ name: 'Ada' }), 'contacts:write');
    });
  });

  describe('stock movement is gated separately from editing an item', () => {
    it('lets a Viewer neither, and a Stocker both', async () => {
      const seed = new ItemRepository(driver);
      const item = await seed.create({ name: 'Screws', locationId: UNASSIGNED_LOCATION_ID, quantity: 10 });

      const viewer = new ItemRepository(driver, withAuthority(asRole('Viewer')));
      await expectDenied(() => viewer.adjustQuantity(item.id, 5), 'stock:write');

      const stocker = new ItemRepository(driver, withAuthority(asRole('Stocker')));
      await expect(stocker.adjustQuantity(item.id, 5)).resolves.toMatchObject({ quantity: 15 });
    });
  });
});
