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
