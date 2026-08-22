/**
 * Issue #538: the two **wholesale-apply** paths must survive a natural-key collision too.
 *
 * `resolveUniqueKeyCollisions` shipped for the delta merge (issue #187) and was called from
 * nowhere else, so the §2 "Merge" backup restore and the §7.2 tombstone-TTL clone-with-salvage
 * both wrote their rows with a plain `ON CONFLICT(id)` upsert. That conflict target does not
 * cover a `UNIQUE(name)` index, so restoring a backup from a device that had independently
 * created a tag of the same name aborted the whole restore, and a device past the tombstone TTL
 * could never complete the very clone the salvage machinery exists to give it.
 *
 * As with `unique-keys.integration.test.ts`, these run over `node:sqlite` with the real
 * migrations and `PRAGMA foreign_keys=ON`. A plan-level assertion cannot catch this class of bug
 * at all: the failure is invisible until a genuine UNIQUE index rejects the INSERT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrations } from '@/db/migrations';
import { itemTagEdgeId } from '@/db/repositories/tombstone';
import { runMigrations } from '@/db/migrations/engine';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runSnapshotMerge } from './merge';
import { buildLocalSnapshot, restoreSnapshot } from './snapshot';

async function freshDevice(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return driver;
}

/** Seed one item carrying the tag `tagName` under the given ids. */
async function seedTaggedItem(
  driver: MemoryDriver,
  opts: { itemId: string; tagId: string; tagName: string; at: number },
): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    opts.itemId,
    opts.itemId,
    UNASSIGNED_LOCATION_ID,
    opts.at,
  ]);
  await driver.execute('INSERT INTO tags (id, name, updated_at) VALUES (?, ?, ?);', [
    opts.tagId,
    opts.tagName,
    opts.at,
  ]);
  await driver.execute('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', [opts.itemId, opts.tagId]);
}

/** Seed one item on loan to `contactName` — the loan is what must follow a retired contact. */
async function seedBorrowedItem(
  driver: MemoryDriver,
  opts: { itemId: string; contactId: string; contactName: string; checkoutId: string; at: number },
): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    opts.itemId,
    opts.itemId,
    UNASSIGNED_LOCATION_ID,
    opts.at,
  ]);
  await driver.execute('INSERT INTO contacts (id, name, updated_at) VALUES (?, ?, ?);', [
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

/** Seed one item carrying a custom-field value under a definition named `Voltage`. */
async function seedFieldValue(
  driver: MemoryDriver,
  opts: { itemId: string; defId: string; valueId: string; value: string; at: number },
): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    opts.itemId,
    opts.itemId,
    UNASSIGNED_LOCATION_ID,
    opts.at,
  ]);
  await driver.execute(
    `INSERT INTO field_defs (id, name, field_type, updated_at) VALUES (?, 'Voltage', 'TEXT', ?);`,
    [opts.defId, opts.at],
  );
  await driver.execute(
    `INSERT INTO item_field_values (id, item_id, def_id, value, updated_at) VALUES (?, ?, ?, ?, ?);`,
    [opts.valueId, opts.itemId, opts.defId, opts.value, opts.at],
  );
}

describe('§2 merge restore resolves natural-key collisions (issue #538)', () => {
  let target: MemoryDriver;
  let source: MemoryDriver;

  beforeEach(async () => {
    target = await freshDevice();
    source = await freshDevice();
  });

  afterEach(async () => {
    await target.close();
    await source.close();
  });

  it('restores a backup whose tag shares a name with a local one', async () => {
    // The ordinary state of a synced pair: both devices invented their own id for "Tools".
    await seedTaggedItem(target, { itemId: 'iLocal', tagId: 'tagLocal', tagName: 'Tools', at: 10 });
    await seedTaggedItem(source, { itemId: 'iBackup', tagId: 'tagBackup', tagName: 'tools', at: 20 });

    const backup = await buildLocalSnapshot(source);

    // Before the fix this raised SQLITE_CONSTRAINT_UNIQUE on `idx_tags_name` and rolled the whole
    // restore back, leaving the user with a raw SQLite error and nothing restored.
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const tags = await target.query<{ id: string }>('SELECT id FROM tags;');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.id).toBe('tagBackup'); // the newer row kept the name

    // Both devices' items carry the surviving tag — the local edge followed the re-key rather
    // than being cascaded away with the retired row.
    const tagged = await target.query<{ item_id: string; tag_id: string }>(
      'SELECT item_id, tag_id FROM item_tags ORDER BY item_id;',
    );
    expect(tagged).toEqual([
      { item_id: 'iBackup', tag_id: 'tagBackup' },
      { item_id: 'iLocal', tag_id: 'tagBackup' },
    ]);

    // The retired id is tombstoned, so the next sync propagates the retirement rather than
    // re-publishing a row that no longer exists.
    const tombstones = await target.query<{ id: string }>(
      "SELECT id FROM tombstones WHERE table_name = 'tags';",
    );
    expect(tombstones.map((t) => t.id)).toEqual(['tagLocal']);
  });

  it('keeps a local loan when its borrower loses the name to the backup', async () => {
    await seedBorrowedItem(target, {
      itemId: 'iLocal',
      contactId: 'cLocal',
      contactName: 'Alex Smith',
      checkoutId: 'kLocal',
      at: 10,
    });
    await seedBorrowedItem(source, {
      itemId: 'iBackup',
      contactId: 'cBackup',
      contactName: 'alex smith',
      checkoutId: 'kBackup',
      at: 20,
    });

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const contacts = await target.query<{ id: string }>('SELECT id FROM contacts;');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.id).toBe('cBackup');

    // The contact FK is ON DELETE CASCADE, so a bare delete would have taken the local loan with
    // it. Both loans survive, pointed at the surviving contact.
    const loans = await target.query<{ id: string; contact_id: string }>(
      'SELECT id, contact_id FROM checkouts ORDER BY id;',
    );
    expect(loans).toEqual([
      { id: 'kBackup', contact_id: 'cBackup' },
      { id: 'kLocal', contact_id: 'cBackup' },
    ]);
  });

  it('merges two "Voltage" definitions and keeps both sides’ values', async () => {
    // The backup's definition is the older of the two, so this time the *incoming* row loses and
    // the local one keeps the name — the direction the restore never used to exercise at all.
    await seedFieldValue(target, {
      itemId: 'iLocal',
      defId: 'defLocal',
      valueId: 'vLocal',
      value: '5V',
      at: 30,
    });
    await seedFieldValue(source, {
      itemId: 'iBackup',
      defId: 'defBackup',
      valueId: 'vBackup',
      value: '12V',
      at: 10,
    });

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const defs = await target.query<{ id: string }>('SELECT id FROM field_defs;');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('defLocal');

    const values = await target.query<{ item_id: string; def_id: string; value: string }>(
      'SELECT item_id, def_id, value FROM item_field_values ORDER BY item_id;',
    );
    expect(values).toEqual([
      { item_id: 'iBackup', def_id: 'defLocal', value: '12V' },
      { item_id: 'iLocal', def_id: 'defLocal', value: '5V' },
    ]);
  });

  it('follows the re-key when it is the backup’s tag that is retired', async () => {
    // The mirror of the first case. The backup's edges name a tag the restore is about to retire,
    // and the M:N joins carry no `id` for the resolution to repoint — so an unmapped edge would
    // name an absent parent, and a foreign-key failure costs the whole restore, not that edge.
    await seedTaggedItem(target, { itemId: 'iLocal', tagId: 'tagLocal', tagName: 'Tools', at: 20 });
    await seedTaggedItem(source, { itemId: 'iBackup', tagId: 'tagBackup', tagName: 'tools', at: 10 });

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const tags = await target.query<{ id: string }>('SELECT id FROM tags;');
    expect(tags.map((t) => t.id)).toEqual(['tagLocal']);

    const tagged = await target.query<{ item_id: string; tag_id: string }>(
      'SELECT item_id, tag_id FROM item_tags ORDER BY item_id;',
    );
    expect(tagged).toEqual([
      { item_id: 'iBackup', tag_id: 'tagLocal' },
      { item_id: 'iLocal', tag_id: 'tagLocal' },
    ]);
  });

  it('keeps the record of who did what when two devices invented one username', async () => {
    // `users.username` is UNIQUE NOCASE over random ids, so the same person set up on both
    // devices collides exactly as a tag does. Retiring the loser must not fire
    // `actor_user_id`'s ON DELETE SET DEFAULT, which would re-attribute this device's own
    // location history to System — losing the attribution the column exists to record.
    for (const [driver, id, username, at] of [
      [target, 'uLocal', 'ada', 10],
      [source, 'uBackup', 'ADA', 20],
    ] as const) {
      await driver.execute(
        `INSERT INTO users (id, username, display_name, kind, updated_at) VALUES (?, ?, ?, 'normal', ?);`,
        [id, username, username, at],
      );
      await driver.execute(
        `INSERT INTO location_history (id, location_id, location_name, action, actor_user_id, updated_at)
         VALUES (?, ?, 'Unassigned', 'RENAMED', ?, ?);`,
        [`lh-${id}`, UNASSIGNED_LOCATION_ID, id, at],
      );
    }

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const users = await target.query<{ id: string }>(
      "SELECT id FROM users WHERE kind = 'normal' ORDER BY id;",
    );
    expect(users.map((u) => u.id)).toEqual(['uBackup']);

    const history = await target.query<{ id: string; actor_user_id: string }>(
      'SELECT id, actor_user_id FROM location_history ORDER BY id;',
    );
    expect(history).toEqual([
      { id: 'lh-uBackup', actor_user_id: 'uBackup' },
      { id: 'lh-uLocal', actor_user_id: 'uBackup' },
    ]);
  });

  it('revokes a losing account’s bridge token rather than failing the restore', async () => {
    // A Bridge / Home Assistant token is deliberately NOT carried to the winning account — a
    // credential must not silently start authenticating as a different principal. Its FK is
    // ON DELETE CASCADE / NOT NULL, so the backup's token has to be dropped along with the row
    // it speaks for; writing it against a retired id would abort the whole restore on the
    // foreign key rather than on the unique index.
    for (const [driver, id, username, at] of [
      [target, 'uLocal', 'ada', 20],
      [source, 'uBackup', 'ADA', 10],
    ] as const) {
      await driver.execute(
        `INSERT INTO users (id, username, display_name, kind, updated_at) VALUES (?, ?, ?, 'normal', ?);`,
        [id, username, username, at],
      );
      await driver.execute(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, updated_at)
         VALUES (?, ?, 'Home Assistant', ?, 'gbn_', ?);`,
        [`tok-${id}`, id, `hash-${id}`, at],
      );
    }

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const users = await target.query<{ id: string }>(
      "SELECT id FROM users WHERE kind = 'normal' ORDER BY id;",
    );
    expect(users.map((u) => u.id)).toEqual(['uLocal']);

    const tokens = await target.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM api_tokens ORDER BY id;',
    );
    expect(tokens).toEqual([{ id: 'tok-uLocal', user_id: 'uLocal' }]);
  });

  it('retires nothing when the backup’s names do not collide', async () => {
    // The guard against the resolution doing anything at all on the common path.
    await seedTaggedItem(target, { itemId: 'iLocal', tagId: 'tagLocal', tagName: 'Tools', at: 10 });
    await seedTaggedItem(source, { itemId: 'iBackup', tagId: 'tagBackup', tagName: 'Fixings', at: 20 });

    const backup = await buildLocalSnapshot(source);
    await expect(restoreSnapshot(target, backup)).resolves.toBeUndefined();

    const tags = await target.query<{ id: string }>('SELECT id FROM tags ORDER BY id;');
    expect(tags.map((t) => t.id)).toEqual(['tagBackup', 'tagLocal']);
    const tombstones = await target.query<{ c: number }>('SELECT COUNT(*) AS c FROM tombstones;');
    expect(Number(tombstones[0]!.c)).toBe(0);
  });
});

describe('§7.2 tombstone-TTL clone resolves natural-key collisions (issue #538)', () => {
  let device: MemoryDriver;
  let peer: MemoryDriver;

  beforeEach(async () => {
    device = await freshDevice();
    peer = await freshDevice();
  });

  afterEach(async () => {
    await device.close();
    await peer.close();
  });

  /** The TTL recovery: wipe, clone `peer` wholesale, re-apply everything edited since `lastSync`. */
  async function cloneWithSalvage(lastSyncTimestamp: number): Promise<unknown> {
    const remote = await buildLocalSnapshot(peer);
    return runSnapshotMerge(device, {
      mode: 'clone',
      remote,
      offset: 0,
      effectiveNow: 100,
      lastSyncTimestamp,
      historyPrunedBefore: 0,
      forceTies: false,
    });
  }

  it('salvages an offline tag whose name the remote already holds', async () => {
    // The device has been away past the 180-day tombstone TTL and created "Tools" offline; the
    // remote independently has its own "Tools". The salvage upsert used to trip `idx_tags_name`,
    // rolling the clone back — and since the device still qualifies for the TTL path, the next
    // attempt recomputed the identical failing plan. Recovery was unreachable.
    await seedTaggedItem(device, { itemId: 'iOffline', tagId: 'tagOffline', tagName: 'Tools', at: 50 });
    await seedTaggedItem(peer, { itemId: 'iRemote', tagId: 'tagRemote', tagName: 'tools', at: 20 });

    await expect(cloneWithSalvage(10)).resolves.toBeDefined();

    const tags = await device.query<{ id: string }>('SELECT id FROM tags;');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.id).toBe('tagOffline'); // the offline edit is the newer row

    // Both the cloned and the salvaged item carry the one surviving tag.
    const tagged = await device.query<{ item_id: string; tag_id: string }>(
      'SELECT item_id, tag_id FROM item_tags ORDER BY item_id;',
    );
    expect(tagged).toEqual([
      { item_id: 'iOffline', tag_id: 'tagOffline' },
      { item_id: 'iRemote', tag_id: 'tagOffline' },
    ]);
  });

  it('keeps the remote’s loan when its borrower loses to an offline contact', async () => {
    await seedBorrowedItem(device, {
      itemId: 'iOffline',
      contactId: 'cOffline',
      contactName: 'Alex Smith',
      checkoutId: 'kOffline',
      at: 50,
    });
    await seedBorrowedItem(peer, {
      itemId: 'iRemote',
      contactId: 'cRemote',
      contactName: 'ALEX SMITH',
      checkoutId: 'kRemote',
      at: 20,
    });

    await expect(cloneWithSalvage(10)).resolves.toBeDefined();

    const contacts = await device.query<{ id: string }>('SELECT id FROM contacts;');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.id).toBe('cOffline');

    const loans = await device.query<{ id: string; contact_id: string }>(
      'SELECT id, contact_id FROM checkouts ORDER BY id;',
    );
    expect(loans).toEqual([
      { id: 'kOffline', contact_id: 'cOffline' },
      { id: 'kRemote', contact_id: 'cOffline' },
    ]);
  });

  it('drops the salvaged row when the remote’s definition is the newer one', async () => {
    // The mirror image: the offline edit loses, so its `item_field_values` row must follow the
    // remote's definition rather than re-inserting against an id the clone never wrote.
    await seedFieldValue(device, {
      itemId: 'iOffline',
      defId: 'defOffline',
      valueId: 'vOffline',
      value: '5V',
      at: 20,
    });
    await seedFieldValue(peer, {
      itemId: 'iRemote',
      defId: 'defRemote',
      valueId: 'vRemote',
      value: '12V',
      at: 50,
    });

    await expect(cloneWithSalvage(10)).resolves.toBeDefined();

    const defs = await device.query<{ id: string }>('SELECT id FROM field_defs;');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('defRemote');

    const values = await device.query<{ item_id: string; def_id: string; value: string }>(
      'SELECT item_id, def_id, value FROM item_field_values ORDER BY item_id;',
    );
    expect(values).toEqual([
      { item_id: 'iOffline', def_id: 'defRemote', value: '5V' },
      { item_id: 'iRemote', def_id: 'defRemote', value: '12V' },
    ]);
  });

  it('keeps an offline tag removal whose tag then loses the name', async () => {
    // An edge tombstone is keyed by (item, tag), so it has to follow the re-key too. Left on the
    // retired id its DELETE matches nothing, and the membership the user removed offline comes
    // straight back under the winning tag — the clone undoing the user's own edit.
    await seedTaggedItem(device, { itemId: 'iShared', tagId: 'tagOffline', tagName: 'Tools', at: 20 });
    await seedTaggedItem(peer, { itemId: 'iShared', tagId: 'tagRemote', tagName: 'tools', at: 50 });

    // Offline, after the last sync, the device unlinks the tag from the item.
    await device.execute('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?;', [
      'iShared',
      'tagOffline',
    ]);
    await device.execute('INSERT INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);', [
      'item_tags',
      itemTagEdgeId('iShared', 'tagOffline'),
      60,
    ]);

    await expect(cloneWithSalvage(10)).resolves.toBeDefined();

    const tags = await device.query<{ id: string }>('SELECT id FROM tags;');
    expect(tags.map((t) => t.id)).toEqual(['tagRemote']); // the remote's row is the newer

    const tagged = await device.query<{ item_id: string; tag_id: string }>(
      'SELECT item_id, tag_id FROM item_tags;',
    );
    expect(tagged).toEqual([]);

    // The removal is recorded against the surviving tag, so it still reaches other devices.
    const tombstones = await device.query<{ id: string }>(
      "SELECT id FROM tombstones WHERE table_name = 'item_tags';",
    );
    expect(tombstones.map((t) => t.id)).toContain(itemTagEdgeId('iShared', 'tagRemote'));
  });

  it('leaves an ordinary collision-free clone alone', async () => {
    await seedTaggedItem(device, { itemId: 'iOffline', tagId: 'tagOffline', tagName: 'Tools', at: 50 });
    await seedTaggedItem(peer, { itemId: 'iRemote', tagId: 'tagRemote', tagName: 'Fixings', at: 20 });

    await expect(cloneWithSalvage(10)).resolves.toBeDefined();

    const tags = await device.query<{ id: string }>('SELECT id FROM tags ORDER BY id;');
    expect(tags.map((t) => t.id)).toEqual(['tagOffline', 'tagRemote']);
  });
});
