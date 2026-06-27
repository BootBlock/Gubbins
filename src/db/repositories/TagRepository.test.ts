import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TagRepository } from './TagRepository';
import { ItemRepository } from './ItemRepository';

describe('TagRepository', () => {
  let driver: MemoryDriver;
  let tags: TagRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    tags = new TagRepository(driver);
    items = new ItemRepository(driver);
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
});
