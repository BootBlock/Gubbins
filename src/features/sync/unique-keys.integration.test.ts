/**
 * Issue #187 end-to-end: the merge must actually *apply* against a real SQLite engine.
 *
 * The pure plan tests in `unique-keys.test.ts` assert the shape of the reconciliation; this
 * file asserts the thing the issue is really about — that `applyPlan` no longer raises
 * `SQLITE_CONSTRAINT_UNIQUE` and roll the whole atomic merge back. A plan-only test cannot
 * catch that: the original bug was invisible until a genuine UNIQUE index rejected the
 * INSERT, so these run over `node:sqlite` with the real schema and `PRAGMA foreign_keys=ON`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { STOCKER_ROLE_ID, VIEWER_ROLE_ID } from '@/features/users/builtin-roles';
import { reconcile } from './reconcile';
import { applyPlan, buildLocalSnapshot, buildSchemaDictionary } from './snapshot';
import { SYNC_TABLES } from '@/db/repositories';
import { ITEM_HISTORY_TABLE } from '@/db/repositories';

async function freshDevice(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return driver;
}

/** Seed one device with an item carrying the tag `tagName` under the given ids. */
async function seedTaggedItem(
  driver: MemoryDriver,
  opts: { itemId: string; itemName: string; tagId: string; tagName: string; at: number },
): Promise<void> {
  await driver.execute(`INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);`, [
    opts.itemId,
    opts.itemName,
    UNASSIGNED_LOCATION_ID,
    opts.at,
  ]);
  await driver.execute(`INSERT INTO tags (id, name, updated_at) VALUES (?, ?, ?);`, [
    opts.tagId,
    opts.tagName,
    opts.at,
  ]);
  await driver.execute(`INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);`, [opts.itemId, opts.tagId]);
}

describe('§7.5 natural-key collisions apply cleanly (issue #187)', () => {
  let deviceA: MemoryDriver;
  let deviceB: MemoryDriver;

  beforeEach(async () => {
    deviceA = await freshDevice();
    deviceB = await freshDevice();
  });

  afterEach(async () => {
    await deviceA.close();
    await deviceB.close();
  });

  it('merges two independently-created "Bolts" tags without tripping UNIQUE(name)', async () => {
    // Both devices, offline, invent their own id for the same tag name.
    await seedTaggedItem(deviceA, {
      itemId: 'iA',
      itemName: 'Item A',
      tagId: 'tagA',
      tagName: 'Bolts',
      at: 10,
    });
    await seedTaggedItem(deviceB, {
      itemId: 'iB',
      itemName: 'Item B',
      tagId: 'tagB',
      tagName: 'bolts', // NOCASE — the index treats this as the same name
      at: 20,
    });

    const local = await buildLocalSnapshot(deviceA);
    const remote = await buildLocalSnapshot(deviceB);
    const dictionary = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

    const plan = reconcile(local, remote, { offset: 0, dictionary });

    // Before the fix this threw SQLITE_CONSTRAINT_UNIQUE and rolled the merge back, leaving
    // the watermark unadvanced so every later sync failed identically.
    await expect(applyPlan(deviceA, plan, dictionary)).resolves.toBeUndefined();

    // One tag survives, carrying BOTH devices' items.
    const tags = await deviceA.query<{ id: string; name: string }>('SELECT id, name FROM tags;');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.id).toBe('tagB'); // newer row won the name

    const tagged = await deviceA.query<{ item_id: string }>(
      'SELECT item_id FROM item_tags ORDER BY item_id;',
    );
    expect(tagged.map((r) => r.item_id)).toEqual(['iA', 'iB']);
  });

  it('merges two "Voltage" field definitions, keeping both devices’ values', async () => {
    for (const [driver, ids] of [
      [deviceA, { def: 'defA', item: 'iA', value: 'vA', text: '5V', at: 30 }],
      [deviceB, { def: 'defB', item: 'iB', value: 'vB', text: '12V', at: 10 }],
    ] as const) {
      await driver.execute(`INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);`, [
        ids.item,
        ids.item,
        UNASSIGNED_LOCATION_ID,
        ids.at,
      ]);
      await driver.execute(
        `INSERT INTO field_defs (id, name, field_type, updated_at) VALUES (?, 'Voltage', 'TEXT', ?);`,
        [ids.def, ids.at],
      );
      await driver.execute(
        `INSERT INTO item_field_values (id, item_id, def_id, value, updated_at) VALUES (?, ?, ?, ?, ?);`,
        [ids.value, ids.item, ids.def, ids.text, ids.at],
      );
    }

    const local = await buildLocalSnapshot(deviceA);
    const remote = await buildLocalSnapshot(deviceB);
    const dictionary = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

    const plan = reconcile(local, remote, { offset: 0, dictionary });
    await expect(applyPlan(deviceA, plan, dictionary)).resolves.toBeUndefined();

    const defs = await deviceA.query<{ id: string }>('SELECT id FROM field_defs;');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('defA'); // newer definition won the name

    // Both values survive, repointed at the surviving definition — a bare delete would have
    // cascaded the incoming one away.
    const values = await deviceA.query<{ item_id: string; def_id: string; value: string }>(
      'SELECT item_id, def_id, value FROM item_field_values ORDER BY item_id;',
    );
    expect(values).toEqual([
      { item_id: 'iA', def_id: 'defA', value: '5V' },
      { item_id: 'iB', def_id: 'defA', value: '12V' },
    ]);
  });

  /**
   * Issue #679. This resolution folds the whole of Unicode; `UNIQUE (name COLLATE NOCASE)` folds
   * ASCII A–Z. So a device can legitimately be holding `Café Ltd` *and* `CAFÉ LTD` — two rows
   * this pass reads as one key. Left to overwrite each other in the resolution, one of them
   * silently drops out, the peer's row contests only the survivor, and the winner's INSERT then
   * lands on the row that was never retired: the merge aborts on the very constraint it exists to
   * route around, and never advances the watermark.
   */
  describe('a device already holding two spellings of one name', () => {
    /** `contactId` borrows `itemId`; the loan is what must follow a retired contact to the winner. */
    async function seedBorrowedItem(
      driver: MemoryDriver,
      opts: {
        itemId: string;
        contactId: string;
        contactName: string;
        checkoutId: string;
        at: number;
      },
    ): Promise<void> {
      await driver.execute(`INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);`, [
        opts.itemId,
        opts.itemId,
        UNASSIGNED_LOCATION_ID,
        opts.at,
      ]);
      await driver.execute(`INSERT INTO contacts (id, name, updated_at) VALUES (?, ?, ?);`, [
        opts.contactId,
        opts.contactName,
        opts.at,
      ]);
      await driver.execute(
        `INSERT INTO checkouts (id, item_id, contact_id, checked_out_at, updated_at)
         VALUES (?, ?, ?, ?, ?);`,
        [opts.checkoutId, opts.itemId, opts.contactId, opts.at, opts.at],
      );
    }

    it('merges them with the peer’s row without tripping UNIQUE(name)', async () => {
      // Both spellings are legal to the index, so a database written before the write paths
      // folded can hold either pair — reached here by typing an accented borrower's name in a
      // different case on two check-outs.
      await seedBorrowedItem(deviceA, {
        itemId: 'i1',
        contactId: 'cA',
        contactName: 'Café Ltd',
        checkoutId: 'k1',
        at: 10,
      });
      await seedBorrowedItem(deviceA, {
        itemId: 'i2',
        contactId: 'cB',
        contactName: 'CAFÉ LTD',
        checkoutId: 'k2',
        at: 20,
      });
      await seedBorrowedItem(deviceB, {
        itemId: 'i3',
        contactId: 'cC',
        contactName: 'café ltd',
        checkoutId: 'k3',
        at: 30,
      });

      const local = await buildLocalSnapshot(deviceA);
      const remote = await buildLocalSnapshot(deviceB);
      const dictionary = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

      const plan = reconcile(local, remote, { offset: 0, dictionary });
      await expect(applyPlan(deviceA, plan, dictionary)).resolves.toBeUndefined();

      // One contact survives — the peer's, as the newest row — and both retired ids merged into
      // it rather than being dropped, so nobody's loan history went with them.
      const contacts = await deviceA.query<{ id: string }>('SELECT id FROM contacts;');
      expect(contacts).toEqual([{ id: 'cC' }]);

      const loans = await deviceA.query<{ id: string; contact_id: string }>(
        'SELECT id, contact_id FROM checkouts ORDER BY id;',
      );
      expect(loans).toEqual([
        { id: 'k1', contact_id: 'cC' },
        { id: 'k2', contact_id: 'cC' },
        { id: 'k3', contact_id: 'cC' },
      ]);
    });

    it('resolves the pair even when the peer contests neither of them', async () => {
      await seedBorrowedItem(deviceA, {
        itemId: 'i1',
        contactId: 'cA',
        contactName: 'Café Ltd',
        checkoutId: 'k1',
        at: 10,
      });
      await seedBorrowedItem(deviceA, {
        itemId: 'i2',
        contactId: 'cB',
        contactName: 'CAFÉ LTD',
        checkoutId: 'k2',
        at: 20,
      });
      // The peer knows nothing about that name — this merge's only job on `contacts` is the
      // clean-up, which is the one path by which an existing pair is ever collapsed.
      await seedBorrowedItem(deviceB, {
        itemId: 'i3',
        contactId: 'cC',
        contactName: 'Someone Else',
        checkoutId: 'k3',
        at: 30,
      });

      const local = await buildLocalSnapshot(deviceA);
      const remote = await buildLocalSnapshot(deviceB);
      const dictionary = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

      await applyPlan(deviceA, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

      const contacts = await deviceA.query<{ id: string }>('SELECT id FROM contacts ORDER BY id;');
      expect(contacts).toEqual([{ id: 'cB' }, { id: 'cC' }]); // `cB` is the newer of the pair
      const loans = await deviceA.query<{ id: string; contact_id: string }>(
        'SELECT id, contact_id FROM checkouts ORDER BY id;',
      );
      expect(loans).toEqual([
        { id: 'k1', contact_id: 'cB' },
        { id: 'k2', contact_id: 'cB' },
        { id: 'k3', contact_id: 'cC' },
      ]);
    });
  });

  /**
   * Retiring a `users` row deletes it, and the two things pointing at it are treated differently
   * on purpose: its **attribution** follows the winner (the surviving account is who did that
   * work), while its **credentials** are revoked (a token must not silently start authenticating
   * as a different principal — see the `users` entry in `UNIQUE_KEY_SPECS`). Both are reachable
   * with no peer involved at all once two local rows on one folded key are contested, which is
   * what makes them worth an end-to-end guard rather than a reading of the spec list.
   */
  it("repoints a retired user's history and revokes its tokens", async () => {
    for (const [id, username, at] of [
      ['uA', 'josé', 10],
      ['uB', 'JOSÉ', 20],
    ] as const) {
      await deviceA.execute(
        `INSERT INTO users (id, username, display_name, kind, updated_at) VALUES (?, ?, ?, 'normal', ?);`,
        [id, username, username, at],
      );
      await deviceA.execute(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, updated_at)
         VALUES (?, ?, 'Home Assistant', ?, 'gbn_', ?);`,
        [`tok-${id}`, id, `hash-${id}`, at],
      );
      await deviceA.execute(
        `INSERT INTO location_history (id, location_id, location_name, action, actor_user_id, updated_at)
         VALUES (?, ?, 'Unassigned', 'RENAMED', ?, ?);`,
        [`lh-${id}`, UNASSIGNED_LOCATION_ID, id, at],
      );
    }
    // The peer contests nothing here; the pair is entirely this device's.
    await deviceB.execute(`INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);`, [
      'iB',
      'Item B',
      UNASSIGNED_LOCATION_ID,
      30,
    ]);

    const local = await buildLocalSnapshot(deviceA);
    const remote = await buildLocalSnapshot(deviceB);
    const dictionary = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

    await applyPlan(deviceA, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

    const survivors = await deviceA.query<{ id: string }>(
      "SELECT id FROM users WHERE kind = 'normal' ORDER BY id;",
    );
    expect(survivors).toEqual([{ id: 'uB' }]);

    // Attribution follows: without the repoint, `ON DELETE SET DEFAULT` would have re-attributed
    // this device's own record of who renamed that location to System.
    const history = await deviceA.query<{ id: string; actor_user_id: string }>(
      'SELECT id, actor_user_id FROM location_history ORDER BY id;',
    );
    expect(history).toEqual([
      { id: 'lh-uA', actor_user_id: 'uB' },
      { id: 'lh-uB', actor_user_id: 'uB' },
    ]);

    // The credential does not: the loser's token is revoked by the cascade rather than handed to
    // whoever now holds the username.
    const tokens = await deviceA.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM api_tokens ORDER BY id;',
    );
    expect(tokens).toEqual([{ id: 'tok-uB', user_id: 'uB' }]);
  });

  it('converges: applying the mirrored merge on the peer reaches the same state', async () => {
    await seedTaggedItem(deviceA, {
      itemId: 'iA',
      itemName: 'Item A',
      tagId: 'tagA',
      tagName: 'Bolts',
      at: 10,
    });
    await seedTaggedItem(deviceB, {
      itemId: 'iB',
      itemName: 'Item B',
      tagId: 'tagB',
      tagName: 'Bolts',
      at: 20,
    });

    const snapA = await buildLocalSnapshot(deviceA);
    const snapB = await buildLocalSnapshot(deviceB);
    const dictA = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const dictB = await buildSchemaDictionary(deviceB, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

    // Each device merges the other's snapshot from the same starting point.
    await applyPlan(deviceA, reconcile(snapA, snapB, { offset: 0, dictionary: dictA }), dictA);
    await applyPlan(deviceB, reconcile(snapB, snapA, { offset: 0, dictionary: dictB }), dictB);

    // Both retired the same id and kept the same one — no ping-pong on the next round.
    const tagsA = await deviceA.query<{ id: string }>('SELECT id FROM tags ORDER BY id;');
    const tagsB = await deviceB.query<{ id: string }>('SELECT id FROM tags ORDER BY id;');
    expect(tagsA).toEqual([{ id: 'tagB' }]);
    expect(tagsB).toEqual([{ id: 'tagB' }]);
  });
});

/**
 * Issue #708: a built-in role that loses the `roles.name` contest is retired with
 * `DELETE FROM roles`, which `trg_roles_protect_builtin_delete` answers with `RAISE(ABORT)` —
 * taking down the whole atomic apply, not the one statement.
 *
 * These run against the real schema with the trigger live, because a plan-level assertion cannot
 * see a `RAISE(ABORT)` at all.
 */
describe('§7.5 a protected row never loses its natural key (issue #708)', () => {
  let deviceA: MemoryDriver;
  let deviceB: MemoryDriver;

  beforeEach(async () => {
    deviceA = await freshDevice();
    deviceB = await freshDevice();
  });

  afterEach(async () => {
    await deviceA.close();
    await deviceB.close();
  });

  /**
   * Flatten every seeded role's `updated_at` so the renames below are the only recent edits.
   * Each device seeds its own built-ins at its own wall-clock instant, which would otherwise
   * decide the LWW pass before the contest under test is ever reached.
   */
  async function flattenRoleStamps(driver: MemoryDriver): Promise<void> {
    await driver.execute('UPDATE roles SET updated_at = 1;');
  }

  /** Merge `from`'s snapshot into `into`, exactly as a sync round would. */
  async function mergeInto(into: MemoryDriver, from: MemoryDriver): Promise<void> {
    const local = await buildLocalSnapshot(into);
    const remote = await buildLocalSnapshot(from);
    const dictionary = await buildSchemaDictionary(into, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    await applyPlan(into, reconcile(local, remote, { offset: 0, dictionary }), dictionary);
  }

  it('retires the custom role, not the built-in one, when the two share a name', async () => {
    // Device A invented a custom role "Curator" and assigned a user to it — *newer* than the
    // built-in row it collides with, so plain last-write-wins would retire the built-in.
    await flattenRoleStamps(deviceA);
    await flattenRoleStamps(deviceB);
    await deviceA.execute(
      'INSERT INTO roles (id, name, permissions, is_builtin, updated_at) VALUES (?, ?, ?, 0, ?);',
      ['role-custom', 'Curator', '[]', 100],
    );
    await deviceA.execute(
      'INSERT INTO users (id, username, display_name, role_id, updated_at) VALUES (?, ?, ?, ?, ?);',
      ['uA', 'alex', 'Alex', 'role-custom', 100],
    );

    // Device B renamed the built-in Stocker onto that same name — legal there, because its own
    // UNIQUE index has never seen "Curator".
    await deviceB.execute('UPDATE roles SET name = ?, updated_at = ? WHERE id = ?;', [
      'Curator',
      50,
      STOCKER_ROLE_ID,
    ]);

    // Before the fix this raised `A built-in role cannot be deleted.` and rolled the merge back,
    // leaving the watermark unadvanced so every later sync recomputed the identical failing plan.
    await expect(mergeInto(deviceA, deviceB)).resolves.toBeUndefined();

    const named = await deviceA.query<{ id: string }>('SELECT id FROM roles WHERE name = ? ORDER BY id;', [
      'Curator',
    ]);
    expect(named).toEqual([{ id: STOCKER_ROLE_ID }]);

    // The custom row is retired and tombstoned, and its user follows the winner rather than
    // being left role-less by `role_id`'s ON DELETE SET NULL.
    const custom = await deviceA.query('SELECT id FROM roles WHERE id = ?;', ['role-custom']);
    expect(custom).toEqual([]);
    const users = await deviceA.query<{ id: string; role_id: string | null }>(
      "SELECT id, role_id FROM users WHERE kind = 'normal';",
    );
    expect(users).toEqual([{ id: 'uA', role_id: STOCKER_ROLE_ID }]);
    const tombstones = await deviceA.query<{ id: string }>(
      "SELECT id FROM tombstones WHERE table_name = 'roles';",
    );
    expect(tombstones).toEqual([{ id: 'role-custom' }]);
  });

  it('converges: the peer reaches the same verdict from the mirrored merge', async () => {
    await flattenRoleStamps(deviceA);
    await flattenRoleStamps(deviceB);
    await deviceA.execute(
      'INSERT INTO roles (id, name, permissions, is_builtin, updated_at) VALUES (?, ?, ?, 0, ?);',
      ['role-custom', 'Curator', '[]', 100],
    );
    await deviceB.execute('UPDATE roles SET name = ?, updated_at = ? WHERE id = ?;', [
      'Curator',
      50,
      STOCKER_ROLE_ID,
    ]);

    const snapA = await buildLocalSnapshot(deviceA);
    const snapB = await buildLocalSnapshot(deviceB);
    const dictA = await buildSchemaDictionary(deviceA, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const dictB = await buildSchemaDictionary(deviceB, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);

    await applyPlan(deviceA, reconcile(snapA, snapB, { offset: 0, dictionary: dictA }), dictA);
    await applyPlan(deviceB, reconcile(snapB, snapA, { offset: 0, dictionary: dictB }), dictB);

    // Both devices kept the built-in and dropped the custom row — no ping-pong next round.
    const q = 'SELECT id FROM roles WHERE name = ? ORDER BY id;';
    expect(await deviceA.query(q, ['Curator'])).toEqual([{ id: STOCKER_ROLE_ID }]);
    expect(await deviceB.query(q, ['Curator'])).toEqual([{ id: STOCKER_ROLE_ID }]);
  });

  it('protects a built-in role this device does not recognise by id', async () => {
    // The trigger fires on `is_builtin = 1`, not on membership of the four seeded ids, so a
    // built-in row from a differently-shaped peer is just as undeletable and must be guarded by
    // its flag. Deleting it would abort the apply exactly as deleting a familiar one does.
    await flattenRoleStamps(deviceA);
    await flattenRoleStamps(deviceB);
    await deviceA.execute(
      'INSERT INTO roles (id, name, permissions, is_builtin, updated_at) VALUES (?, ?, ?, 1, ?);',
      ['role-foreign', 'Curator', '[]', 50],
    );
    await deviceB.execute(
      'INSERT INTO roles (id, name, permissions, is_builtin, updated_at) VALUES (?, ?, ?, 0, ?);',
      ['role-custom', 'Curator', '[]', 100],
    );

    await expect(mergeInto(deviceA, deviceB)).resolves.toBeUndefined();

    const named = await deviceA.query<{ id: string }>('SELECT id FROM roles WHERE name = ?;', ['Curator']);
    expect(named).toEqual([{ id: 'role-foreign' }]);
  });

  it('refuses the contest when the peer renames a second built-in onto a built-in name', async () => {
    // Neither row can be retired, so the contest is refused rather than settled: both survive,
    // and the peer's rename is the one that does not land.
    await flattenRoleStamps(deviceA);
    await flattenRoleStamps(deviceB);
    await deviceA.execute('UPDATE roles SET name = ?, updated_at = ? WHERE id = ?;', [
      'Keeper',
      100,
      STOCKER_ROLE_ID,
    ]);
    await deviceB.execute('UPDATE roles SET name = ?, updated_at = ? WHERE id = ?;', [
      'Keeper',
      200,
      VIEWER_ROLE_ID,
    ]);

    await expect(mergeInto(deviceA, deviceB)).resolves.toBeUndefined();

    const roles = await deviceA.query<{ id: string; name: string }>(
      'SELECT id, name FROM roles WHERE id IN (?, ?) ORDER BY id;',
      [STOCKER_ROLE_ID, VIEWER_ROLE_ID],
    );
    // The local row keeps the contested name; the peer's rename is the one refused.
    expect(roles).toEqual([
      { id: STOCKER_ROLE_ID, name: 'Keeper' },
      { id: VIEWER_ROLE_ID, name: 'Viewer' },
    ]);
    expect(await deviceA.query("SELECT id FROM tombstones WHERE table_name = 'roles';")).toEqual([]);
  });
});
