import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TagNameInUseError, TagRepository } from './TagRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

describe('TagRepository', () => {
  let driver: MemoryDriver;
  let tags: TagRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    tags = new TagRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('auto-creates tags by name when assigning them to an item (low friction)', async () => {
    const item = await items.create({ name: 'ESP32 Dev Board' });
    await tags.setForItem(item.id, ['esp32', 'wifi', 'microcontroller']);

    const assigned = await tags.getForItem(item.id);
    expect(assigned.map((t) => t.name).sort()).toEqual(['esp32', 'microcontroller', 'wifi']);
  });

  it('reuses an existing tag case-insensitively rather than duplicating it', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    await tags.setForItem(a.id, ['ESP32']);
    await tags.setForItem(b.id, ['esp32']);

    const dict = await tags.list();
    const esp = dict.rows.filter((t) => t.name.toLowerCase() === 'esp32');
    expect(esp).toHaveLength(1);
    expect(esp[0]?.itemCount).toBe(2);
  });

  it('diffs the set: adds new, removes dropped, trims and dedupes input', async () => {
    const item = await items.create({ name: 'Widget' });
    await tags.setForItem(item.id, ['a', 'b']);
    await tags.setForItem(item.id, ['  b  ', 'b', 'c', '']); // drop a, keep b, add c, ignore blank

    const assigned = await tags.getForItem(item.id);
    expect(assigned.map((t) => t.name).sort()).toEqual(['b', 'c']);
  });

  it('lists the tag dictionary with live item counts, ordered by name', async () => {
    const a = await items.create({ name: 'A' });
    await tags.setForItem(a.id, ['zeta', 'alpha']);

    const dict = await tags.list();
    expect(dict.rows.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(dict.rows.every((t) => t.itemCount === 1)).toBe(true);
  });

  it('lists tag names without usage counts, ordered case-insensitively', async () => {
    const a = await items.create({ name: 'A' });
    await tags.setForItem(a.id, ['Zeta', 'alpha']);

    const page = await tags.listNames();
    expect(page.rows.map((t) => t.name)).toEqual(['alpha', 'Zeta']);
  });

  it('suggests tags by prefix for autocomplete', async () => {
    const a = await items.create({ name: 'A' });
    await tags.setForItem(a.id, ['arduino', 'arm', 'wifi']);

    const suggestions = await tags.suggest('ar');
    expect(suggestions.map((t) => t.name).sort()).toEqual(['arduino', 'arm']);
  });

  it('clears all tags from an item when set to an empty list', async () => {
    const item = await items.create({ name: 'Widget' });
    await tags.setForItem(item.id, ['x', 'y']);
    await tags.setForItem(item.id, []);
    expect(await tags.getForItem(item.id)).toHaveLength(0);
  });

  it('honours the storage Hard Stop on tag growth writes', async () => {
    const item = await items.create({ name: 'Widget' });
    const locked = new TagRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.setForItem(item.id, ['new'])).rejects.toMatchObject({
      code: 'WRITE_SUSPENDED',
    });
  });

  // --- location tagging + shared dictionary (issue #84) ----------------------------

  it('tags a location, sharing the same dictionary as items', async () => {
    const item = await items.create({ name: 'Torch' });
    const location = await locations.create({ name: 'Van' });
    await tags.setForItem(item.id, ['portable']);
    await tags.setForLocation(location.id, ['portable', 'mobile']);

    expect((await tags.getForLocation(location.id)).map((t) => t.name).sort()).toEqual([
      'mobile',
      'portable',
    ]);
    // "portable" is one shared tag, now carried by both an item and a location.
    const dict = await tags.list();
    const portable = dict.rows.find((t) => t.name === 'portable');
    expect(portable).toMatchObject({ itemCount: 1, locationCount: 1 });
    const mobile = dict.rows.find((t) => t.name === 'mobile');
    expect(mobile).toMatchObject({ itemCount: 0, locationCount: 1 });
  });

  it('creates a tag directly, reusing an existing one case-insensitively', async () => {
    const created = await tags.create('Fragile');
    const again = await tags.create('fragile');
    expect(again.id).toBe(created.id);
    expect((await tags.list()).rows).toHaveLength(1);
  });

  it('renames a tag, and rejects a name already taken by another tag', async () => {
    const a = await tags.create('alpha');
    const b = await tags.create('beta');
    await tags.rename(a.id, 'gamma');
    expect((await tags.list()).rows.map((t) => t.name)).toEqual(['beta', 'gamma']);

    await expect(tags.rename(a.id, 'BETA')).rejects.toBeInstanceOf(TagNameInUseError);
    await expect(tags.rename(a.id, 'BETA')).rejects.toMatchObject({ existingTagId: b.id });
  });

  it('deletes a tag, cascading its item and location edges away', async () => {
    const item = await items.create({ name: 'Widget' });
    const location = await locations.create({ name: 'Shelf' });
    await tags.setForItem(item.id, ['temp']);
    await tags.setForLocation(location.id, ['temp']);
    const [temp] = (await tags.list()).rows;

    await tags.remove(temp!.id);
    expect(await tags.getForItem(item.id)).toHaveLength(0);
    expect(await tags.getForLocation(location.id)).toHaveLength(0);
    expect((await tags.list()).rows).toHaveLength(0);
  });

  it('merges one tag into another across items and locations', async () => {
    const item = await items.create({ name: 'Widget' });
    const location = await locations.create({ name: 'Shelf' });
    await tags.setForItem(item.id, ['wip']);
    await tags.setForLocation(location.id, ['wip']);
    const target = await tags.create('work-in-progress');
    const source = (await tags.list()).rows.find((t) => t.name === 'wip')!;

    await tags.merge(source.id, target.id);

    expect((await tags.getForItem(item.id)).map((t) => t.name)).toEqual(['work-in-progress']);
    expect((await tags.getForLocation(location.id)).map((t) => t.name)).toEqual(['work-in-progress']);
    // The source tag is gone; the target now carries both.
    const dict = await tags.list();
    expect(dict.rows).toHaveLength(1);
    expect(dict.rows[0]).toMatchObject({ name: 'work-in-progress', itemCount: 1, locationCount: 1 });
  });

  it('batches tags for many items, and lists location tag edges', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    await tags.setForItem(a.id, ['x', 'y']);
    await tags.setForItem(b.id, ['y']);

    const rows = await tags.listForItems([a.id, b.id]);
    const byItem = new Map<string, string[]>();
    for (const { itemId, name } of rows) byItem.set(itemId, [...(byItem.get(itemId) ?? []), name]);
    expect(byItem.get(a.id)?.sort()).toEqual(['x', 'y']);
    expect(byItem.get(b.id)).toEqual(['y']);
    expect(await tags.listForItems([])).toEqual([]);

    const location = await locations.create({ name: 'Bin' });
    await tags.setForLocation(location.id, ['x']);
    const edges = await tags.listLocationTagEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ locationId: location.id, tagName: 'x' });
  });
});
