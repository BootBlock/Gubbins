import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { ImageRepository } from './ImageRepository';

describe('ItemRepository — Phase 3 (serialised clone + list thumbnails)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let images: ImageRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    images = new ImageRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates a single item with a null serial number', async () => {
    const item = await items.create({ name: 'Solo', trackingMode: 'SERIALISED' });
    expect(item.serialNo).toBeNull();
    expect(item.quantity).toBe(1);
  });

  it('auto-clones N distinct serialised records sharing a name (§4)', async () => {
    const created = await items.createSerialised({
      name: 'Fluke Multimeter',
      trackingMode: 'SERIALISED',
      count: 3,
    });
    expect(created).toHaveLength(3);
    expect(created.map((i) => i.serialNo)).toEqual([1, 2, 3]);
    expect(created.every((i) => i.name === 'Fluke Multimeter')).toBe(true);
    expect(created.every((i) => i.quantity === 1)).toBe(true);
    // Distinct primary keys.
    expect(new Set(created.map((i) => i.id)).size).toBe(3);

    // Each clone logged its own CREATED entry.
    for (const clone of created) {
      const history = await items.getHistory(clone.id);
      expect(history.rows.some((h) => h.action === 'CREATED')).toBe(true);
    }
  });

  it('treats createSerialised with count 1 (or omitted) as a single instance #1', async () => {
    const created = await items.createSerialised({ name: 'Scope', trackingMode: 'SERIALISED' });
    expect(created).toHaveLength(1);
    expect(created[0]?.serialNo).toBe(1);
  });

  it('includes the primary thumbnail in list reads but never the full-res path (§4.2.4)', async () => {
    const item = await items.create({ name: 'Pictured' });
    const thumb = new Uint8Array([1, 2, 3, 4]);
    // Two images; the lower position is the primary.
    await images.add({
      itemId: item.id,
      thumbnailBlob: new Uint8Array([9, 9]),
      fullResOpfsPath: '/images/second.webp',
      position: 5,
    });
    await images.add({
      itemId: item.id,
      thumbnailBlob: thumb,
      fullResOpfsPath: '/images/primary.webp',
      position: 0,
    });

    const page = await items.list();
    const row = page.rows.find((i) => i.id === item.id);
    expect(row?.thumbnailBlob).toBeInstanceOf(Uint8Array);
    expect(Array.from(row!.thumbnailBlob as Uint8Array)).toEqual([1, 2, 3, 4]);
    // The Item domain object never carries a full-res path field.
    expect(row).not.toHaveProperty('fullResOpfsPath');
  });

  it('returns a null thumbnail for items without images', async () => {
    const item = await items.create({ name: 'Plain' });
    const page = await items.list();
    expect(page.rows.find((i) => i.id === item.id)?.thumbnailBlob).toBeNull();
  });

  it('honours the storage Hard Stop on serialised cloning', async () => {
    const locked = new ItemRepository(driver, { isWriteSuspended: () => true });
    await expect(
      locked.createSerialised({ name: 'Nope', trackingMode: 'SERIALISED', count: 2 }),
    ).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
  });
});
