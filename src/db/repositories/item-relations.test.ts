import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, TombstoneRepository, UNASSIGNED_LOCATION_ID } from './index';

/**
 * Related-items cross-links (feature-gap G6). Exercises the repository seam: adding a relation
 * validates + canonicalises via the pure `planRelation`, is idempotent (deterministic id), lists
 * reciprocally with the other item's name resolved, rejects self/unknown-kind, and a remove
 * DELETEs + tombstones (a no-op remove records nothing).
 */
describe('Item relations (feature-gap G6)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let tombstones: TombstoneRepository;
  let a: string;
  let b: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    tombstones = new TombstoneRepository(driver);
    a = (await items.create({ name: 'Camera', locationId: UNASSIGNED_LOCATION_ID })).id;
    b = (await items.create({ name: 'Tripod', locationId: UNASSIGNED_LOCATION_ID })).id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('adds a directional relation and lists it reciprocally with the other item resolved', async () => {
    const rel = await items.addRelation({ fromItemId: a, toItemId: b, kind: 'ACCESSORY_FOR' });
    expect(rel.kind).toBe('ACCESSORY_FOR');
    expect(rel.id).toBe(`${a}|${b}|ACCESSORY_FOR`);

    const fromA = await items.listRelations(a);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ otherItemId: b, otherItemName: 'Tripod', kind: 'ACCESSORY_FOR' });

    const fromB = await items.listRelations(b);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ otherItemId: a, otherItemName: 'Camera' });
  });

  it('is idempotent — re-adding (symmetric, either order) returns the same row, no duplicate', async () => {
    const first = await items.addRelation({ fromItemId: a, toItemId: b, kind: 'WORKS_WITH' });
    const again = await items.addRelation({ fromItemId: b, toItemId: a, kind: 'WORKS_WITH' });
    expect(again.id).toBe(first.id);
    expect(await items.listRelations(a)).toHaveLength(1);
  });

  it('trims an optional note, storing blank as null', async () => {
    const withNote = await items.addRelation({
      fromItemId: a,
      toItemId: b,
      kind: 'SPARE_FOR',
      note: '  via adapter  ',
    });
    expect(withNote.note).toBe('via adapter');
  });

  it('rejects a self-relation', async () => {
    await expect(items.addRelation({ fromItemId: a, toItemId: a, kind: 'WORKS_WITH' })).rejects.toThrow(
      /itself/i,
    );
  });

  it('rejects an unknown kind', async () => {
    await expect(items.addRelation({ fromItemId: a, toItemId: b, kind: 'bestie' })).rejects.toThrow(
      /Unknown relationship/i,
    );
  });

  it('rejects a relation to a non-existent item', async () => {
    await expect(
      items.addRelation({ fromItemId: a, toItemId: 'ghost', kind: 'WORKS_WITH' }),
    ).rejects.toThrow();
  });

  it('removes a relation, recording a tombstone so the deletion propagates', async () => {
    const rel = await items.addRelation({ fromItemId: a, toItemId: b, kind: 'WORKS_WITH' });
    await items.removeRelation(rel.id);
    expect(await items.listRelations(a)).toHaveLength(0);
    expect(await tombstones.has('item_relations', rel.id)).toBe(true);
  });

  it('is a genuine no-op removing an unknown id — no stray tombstone', async () => {
    await items.removeRelation('does-not-exist');
    expect(await tombstones.has('item_relations', 'does-not-exist')).toBe(false);
  });

  it('cascades relations when an endpoint item is hard-deleted', async () => {
    await items.addRelation({ fromItemId: a, toItemId: b, kind: 'ACCESSORY_FOR' });
    await items.hardDelete(b);
    expect(await items.listRelations(a)).toHaveLength(0);
  });
});
