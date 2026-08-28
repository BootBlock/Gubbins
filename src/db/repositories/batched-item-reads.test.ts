/**
 * The batched per-item reads the export depends on (issue #527).
 *
 * Every export scope used to resolve each item's fields, loans, history, images and attachments
 * with its own query, so a large catalogue cost hundreds of thousands of round-trips. Each of the
 * reads here answers for a *set* of items instead. The single-item forms are either derived from
 * the batched one (`resolveItemFields`) or already covered by their own suites, so what these
 * tests cover is what only a set can get wrong: attributing a row to the wrong item, letting one
 * item's inheritance chain decide another's value, dropping an item that has nothing, and
 * applying a per-item cap across the set rather than within each item.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { AttachmentRepository } from './AttachmentRepository';
import { CategoryRepository, INHERIT_VALUE } from './CategoryRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

describe('batched per-item reads (issue #527)', () => {
  let driver: MemoryDriver;
  let attachments: AttachmentRepository;
  let categories: CategoryRepository;
  let checkouts: CheckoutRepository;
  let contacts: ContactRepository;
  let images: ImageRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    attachments = new AttachmentRepository(driver);
    categories = new CategoryRepository(driver);
    checkouts = new CheckoutRepository(driver);
    contacts = new ContactRepository(driver);
    images = new ImageRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('CategoryRepository.resolveItemFieldsMany', () => {
    it('resolves each item against its own location chain, not the set’s', async () => {
      // Two sibling locations offering *different* values for one shared definition. Resolved one
      // item at a time this could not go wrong; resolved as a set, a chain looked up once and
      // reused would give both items the same manufacturer.
      const shed = await locations.create({ name: 'Shed' });
      const van = await locations.create({ name: 'Van' });
      const tools = await categories.create({ name: 'Power tools' });
      const field = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      await categories.setLocationFieldValue(shed.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setLocationFieldValue(van.id, {
        defId: field.defId,
        value: 'Makita',
        isInheritable: true,
      });
      const drill = await items.create({ name: 'Drill', categoryId: tools.id, locationId: shed.id });
      const sander = await items.create({ name: 'Sander', categoryId: tools.id, locationId: van.id });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });
      await categories.setItemFieldValues(sander.id, { [field.id]: INHERIT_VALUE });

      const byItem = await categories.resolveItemFieldsMany([drill.id, sander.id]);
      expect(byItem.get(drill.id)?.map((f) => f.value)).toEqual(['Ryobi']);
      expect(byItem.get(sander.id)?.map((f) => f.value)).toEqual(['Makita']);
    });

    it('keeps a stored literal on the item that stored it', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const field = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      const drill = await items.create({ name: 'Drill', categoryId: tools.id });
      const sander = await items.create({ name: 'Sander', categoryId: tools.id });
      await categories.setItemFieldValues(drill.id, { [field.id]: 'Bosch' });

      const byItem = await categories.resolveItemFieldsMany([drill.id, sander.id]);
      expect(byItem.get(drill.id)?.[0]?.value).toBe('Bosch');
      expect(byItem.get(drill.id)?.[0]?.hasStoredValue).toBe(true);
      // The sibling shares the definition but stored nothing, so it resolves to the default.
      expect(byItem.get(sander.id)?.[0]?.value).toBeNull();
      expect(byItem.get(sander.id)?.[0]?.hasStoredValue).toBe(false);
    });

    it('leaves an uncategorised item and an unknown id out of the map', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      const drill = await items.create({ name: 'Drill', categoryId: tools.id });
      const loose = await items.create({ name: 'Loose bolt' });

      const byItem = await categories.resolveItemFieldsMany([drill.id, loose.id, 'no-such-item']);
      expect(byItem.has(drill.id)).toBe(true);
      expect(byItem.has(loose.id)).toBe(false);
      expect(byItem.has('no-such-item')).toBe(false);
    });

    it('returns each item’s fields in the rendered order, key fields first', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      await categories.addField(tools.id, { name: 'Zeta', fieldType: 'TEXT', position: 0 });
      await categories.addField(tools.id, { name: 'Alpha', fieldType: 'TEXT', position: 1 });
      await categories.addField(tools.id, {
        name: 'Key',
        fieldType: 'TEXT',
        position: 2,
        prominence: 'key',
      });
      const drill = await items.create({ name: 'Drill', categoryId: tools.id });
      const sander = await items.create({ name: 'Sander', categoryId: tools.id });

      const byItem = await categories.resolveItemFieldsMany([drill.id, sander.id]);
      // Key definitions lead, then declared position — the order every other field read uses,
      // and the one the catalogue CSV's column order is taken from.
      expect(byItem.get(drill.id)?.map((f) => f.name)).toEqual(['Key', 'Zeta', 'Alpha']);
      expect(byItem.get(sander.id)?.map((f) => f.name)).toEqual(['Key', 'Zeta', 'Alpha']);
    });

    it('queries nothing for an empty set', async () => {
      expect((await categories.resolveItemFieldsMany([])).size).toBe(0);
    });
  });

  describe('ItemRepository.getHistoryForItems', () => {
    it('applies the cap within each item, not across the set', async () => {
      // The trap a whole-set read then trimmed would fall into: one busy item's entries would
      // fill the cap and the quiet item would come back with nothing.
      const busy = await items.create({ name: 'Busy', quantity: 0 });
      const quiet = await items.create({ name: 'Quiet', quantity: 0 });
      for (let i = 0; i < 5; i += 1) await items.adjustQuantity(busy.id, 1, `busy ${i}`);
      await items.adjustQuantity(quiet.id, 1, 'quiet 0');

      const byItem = await items.getHistoryForItems([busy.id, quiet.id], 3);
      expect(byItem.get(busy.id)).toHaveLength(3);
      expect(byItem.get(quiet.id)).toHaveLength(2);
    });

    it('returns the same newest entries, in the same order, as the single-item read', async () => {
      const drill = await items.create({ name: 'Drill', quantity: 0 });
      for (let i = 0; i < 4; i += 1) await items.adjustQuantity(drill.id, 1, `note ${i}`);

      const batched = (await items.getHistoryForItems([drill.id], 3)).get(drill.id) ?? [];
      const single = (await items.getHistory(drill.id, { limit: 3 })).rows;
      expect(batched.map((e) => e.id)).toEqual(single.map((e) => e.id));
      expect(batched).toHaveLength(3);
    });

    it('omits an item with no history and queries nothing for an empty set', async () => {
      const fresh = await items.create({ name: 'Fresh' });
      // A created item already carries its CREATED entry, so empty the log outright to get an
      // item the read must skip rather than key to an empty array.
      await driver.execute('DELETE FROM item_history WHERE item_id = ?;', [fresh.id]);
      expect((await items.getHistoryForItems([fresh.id], 10)).has(fresh.id)).toBe(false);
      expect((await items.getHistoryForItems([], 10)).size).toBe(0);
    });
  });

  describe('CheckoutRepository.listForItems', () => {
    it('returns every loan of every item, grouped by item and open first', async () => {
      const drill = await items.create({ name: 'Drill', quantity: 5 });
      const sander = await items.create({ name: 'Sander', quantity: 5 });
      const ada = await contacts.resolveOrCreate('Ada');
      const closed = await checkouts.checkout({ itemId: drill.id, contactId: ada.id });
      await checkouts.checkIn(closed.id);
      const open = await checkouts.checkout({ itemId: drill.id, contactId: ada.id });
      const other = await checkouts.checkout({ itemId: sander.id, contactId: ada.id });

      const rows = await checkouts.listForItems([drill.id, sander.id]);
      expect(rows).toHaveLength(3);
      // The drill's two loans arrive together, the still-open one first. Compared against the
      // single-item read rather than against a literal, so the two cannot drift apart unnoticed.
      const drillLoans = rows.filter((r) => r.itemId === drill.id).map((r) => r.id);
      expect(drillLoans).toEqual([open.id, closed.id]);
      expect(drillLoans).toEqual((await checkouts.listForItem(drill.id)).rows.map((r) => r.id));
      expect(rows.map((r) => r.id)).toContain(other.id);
    });

    it('carries the whole loan history, not one page of it', async () => {
      // The export asked for `{ limit: 100 }` per item, so a heavily-lent item lost the rest.
      const drill = await items.create({ name: 'Drill', quantity: 200 });
      const ada = await contacts.resolveOrCreate('Ada');
      for (let i = 0; i < 120; i += 1) {
        const loan = await checkouts.checkout({ itemId: drill.id, contactId: ada.id });
        await checkouts.checkIn(loan.id);
      }
      expect(await checkouts.listForItems([drill.id])).toHaveLength(120);
    });

    it('queries nothing for an empty set', async () => {
      expect(await checkouts.listForItems([])).toEqual([]);
    });
  });

  describe('ImageRepository / AttachmentRepository listForItems', () => {
    it('keys each item’s rows to that item, in the same order as the single-item read', async () => {
      const drill = await items.create({ name: 'Drill' });
      const sander = await items.create({ name: 'Sander' });
      const bare = await items.create({ name: 'Bare' });
      await images.add({ itemId: drill.id, thumbnailBlob: null, fullResOpfsPath: 'b.webp', position: 1 });
      await images.add({ itemId: drill.id, thumbnailBlob: null, fullResOpfsPath: 'a.webp', position: 0 });
      await images.add({ itemId: sander.id, thumbnailBlob: null, fullResOpfsPath: 'c.webp' });
      await attachments.add({ itemId: drill.id, kind: 'URL', value: 'https://example.com/b', position: 1 });
      await attachments.add({ itemId: drill.id, kind: 'URL', value: 'https://example.com/a', position: 0 });

      // Position, not insertion order, decides the order — asserted against a literal so the
      // expectation cannot be satisfied by whatever the reads happen to agree on …
      const imagesByItem = await images.listForItems([drill.id, sander.id, bare.id]);
      expect(imagesByItem.get(drill.id)?.map((i) => i.fullResOpfsPath)).toEqual(['a.webp', 'b.webp']);
      expect(imagesByItem.get(sander.id)?.map((i) => i.fullResOpfsPath)).toEqual(['c.webp']);
      expect(imagesByItem.has(bare.id)).toBe(false);

      const attachmentsByItem = await attachments.listForItems([drill.id, bare.id]);
      expect(attachmentsByItem.get(drill.id)?.map((a) => a.value)).toEqual([
        'https://example.com/a',
        'https://example.com/b',
      ]);
      expect(attachmentsByItem.has(bare.id)).toBe(false);

      // … and then against the single-item reads, which is the comparison that goes red if the
      // two ever stop sharing an ordering.
      expect(imagesByItem.get(drill.id)?.map((i) => i.id)).toEqual(
        (await images.listForItem(drill.id)).map((i) => i.id),
      );
      expect(attachmentsByItem.get(drill.id)?.map((a) => a.id)).toEqual(
        (await attachments.listForItem(drill.id)).map((a) => a.id),
      );
    });

    it('queries nothing for an empty set', async () => {
      expect((await images.listForItems([])).size).toBe(0);
      expect((await attachments.listForItems([])).size).toBe(0);
    });
  });
});
