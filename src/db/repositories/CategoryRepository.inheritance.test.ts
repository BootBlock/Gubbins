/**
 * Location-inherited custom fields, end-to-end through the repository (issue #97).
 *
 * The precedence rules themselves are unit-tested in the pure `location-inheritance` seam;
 * these cover the parts only a real database exercises — the dictionary's reuse-by-name,
 * the ancestry walk against actual `locations` rows, and the round-trip of the stored
 * inherit *intent* through `setItemFieldValues` → `resolveItemFields`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository, INHERIT_VALUE } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

describe('CategoryRepository — location-inherited fields (issue #97)', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Workshop → Cabinet, a category with a Manufacturer field, and an item in the cabinet. */
  async function scenario() {
    const workshop = await locations.create({ name: 'Workshop' });
    const cabinet = await locations.create({ name: 'Cabinet A', parentId: workshop.id });
    const tools = await categories.create({ name: 'Power tools' });
    const field = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
    const drill = await items.create({ name: 'Drill', categoryId: tools.id, locationId: cabinet.id });
    return { workshop, cabinet, tools, field, drill };
  }

  describe('the global field dictionary', () => {
    it('reuses one definition when two categories declare the same field name', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      const a = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      const b = await categories.addField(spares.id, { name: 'Manufacturer', fieldType: 'TEXT' });

      // Different uses of the field, but one shared definition — the identity that makes a
      // location's inheritable Manufacturer reach items in *either* category.
      expect(a.id).not.toBe(b.id);
      expect(a.defId).toBe(b.defId);
      expect(await categories.listFieldDefs()).toHaveLength(1);
    });

    it('matches an existing definition case-insensitively', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      const a = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      const b = await categories.addField(spares.id, { name: 'manufacturer', fieldType: 'TEXT' });
      expect(a.defId).toBe(b.defId);
    });

    it('refuses to redefine an existing field name with a different type', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      await categories.addField(tools.id, { name: 'Rating', fieldType: 'TEXT' });
      // Retyping the shared definition would reinterpret every stored value app-wide.
      await expect(categories.addField(spares.id, { name: 'Rating', fieldType: 'NUMBER' })).rejects.toThrow(
        DbError,
      );
    });

    it('renaming a field moves it for every category using it', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      const a = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      await categories.addField(spares.id, { name: 'Manufacturer', fieldType: 'TEXT' });

      await categories.updateField(a.id, { name: 'Brand' });
      const spareFields = await categories.listFields(spares.id);
      expect(spareFields[0]?.name).toBe('Brand');
    });

    it('rejects renaming a field onto another definition’s name', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const maker = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      await categories.addField(tools.id, { name: 'Voltage', fieldType: 'TEXT' });
      await expect(categories.updateField(maker.id, { name: 'Voltage' })).rejects.toThrow(DbError);
    });

    it('keeps required/default/position category-local rather than shared', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      const a = await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      await categories.addField(spares.id, { name: 'Manufacturer', fieldType: 'TEXT' });

      await categories.updateField(a.id, { isRequired: true, defaultValue: 'Unknown' });
      const spareFields = await categories.listFields(spares.id);
      expect(spareFields[0]?.isRequired).toBe(false);
      expect(spareFields[0]?.defaultValue).toBeNull();
    });
  });

  describe('resolving an item’s fields', () => {
    it('offers no inheritance when no location above the item sets the field', async () => {
      const { drill } = await scenario();
      const [field] = await categories.resolveItemFields(drill.id);
      expect(field?.inheritable).toBeNull();
      expect(field?.source).toBe('default');
    });

    it('offers a value set on an ancestor without yet applying it', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });

      const [resolved] = await categories.resolveItemFields(drill.id);
      // Available, but the item has not opted in — so it is not yet the value.
      expect(resolved?.inheritable).toMatchObject({ value: 'Ryobi', locationName: 'Workshop' });
      expect(resolved?.value).toBeNull();
      expect(resolved?.source).toBe('default');
    });

    it('does not offer a value the location has not marked inheritable', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: false,
      });
      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.inheritable).toBeNull();
    });

    it('applies the inherited value once the item opts in', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });

      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Ryobi');
      expect(resolved?.source).toBe('inherited');
      expect(resolved?.mode).toBe('inherit');
    });

    it('re-resolves live when the location’s value changes', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });

      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Makita',
        isInheritable: true,
      });
      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Makita');
    });

    it('re-resolves live when the item moves to a location offering a different value', async () => {
      const { drill, workshop, field } = await scenario();
      const garage = await locations.create({ name: 'Garage' });
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setLocationFieldValue(garage.id, {
        defId: field.defId,
        value: 'Bosch',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });
      expect((await categories.resolveItemFields(drill.id))[0]?.value).toBe('Ryobi');

      // `move` is the relocation path (it maintains the per-location stock ledger too).
      await items.move(drill.id, garage.id);
      expect((await categories.resolveItemFields(drill.id))[0]?.value).toBe('Bosch');
    });

    it('takes the nearest ancestor when a parent and child both offer a value', async () => {
      const { drill, workshop, cabinet, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setLocationFieldValue(cabinet.id, {
        defId: field.defId,
        value: 'Makita',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });

      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Makita');
      expect(resolved?.inheritable?.locationName).toBe('Cabinet A');
    });

    it('keeps the inherit intent but falls back when the offer is withdrawn', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });
      await categories.removeLocationFieldValue(workshop.id, field.defId);

      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBeNull();
      expect(resolved?.source).toBe('default');
      // The intent survives, so restoring the offer restores the inheritance.
      expect(resolved?.mode).toBe('inherit');

      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      expect((await categories.resolveItemFields(drill.id))[0]?.value).toBe('Ryobi');
    });

    it('refuses to inherit where nothing above the item offers the field', async () => {
      const { drill, field } = await scenario();
      await expect(categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE })).rejects.toThrow(
        DbError,
      );
    });

    it('lets a stored value replace an inherited one, and inheritance resume after', async () => {
      const { drill, workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });

      await categories.setItemFieldValues(drill.id, { [field.id]: 'Makita' });
      let [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Makita');
      expect(resolved?.source).toBe('stored');
      // The offer is still reported, so the editor can present <Inherit> again.
      expect(resolved?.inheritable?.value).toBe('Ryobi');

      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });
      [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Ryobi');
      expect(resolved?.source).toBe('inherited');
    });

    it('keeps an item’s value when it moves to a category sharing the definition', async () => {
      const { drill, field } = await scenario();
      const spares = await categories.create({ name: 'Spares' });
      await categories.addField(spares.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      await categories.setItemFieldValues(drill.id, { [field.id]: 'Makita' });

      // Values key on the definition, so recategorising does not lose them.
      await items.update(drill.id, { categoryId: spares.id });
      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBe('Makita');
    });
  });

  describe('location field values', () => {
    it('keeps a blank value as a row rather than deleting it', async () => {
      const { workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: '' });
      const values = await categories.listLocationFieldValues(workshop.id);
      expect(values).toHaveLength(1);
      expect(values[0]?.value).toBeNull();
    });

    it('removes a value only on an explicit remove', async () => {
      const { workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: 'Ryobi' });
      await categories.removeLocationFieldValue(workshop.id, field.defId);
      expect(await categories.listLocationFieldValues(workshop.id)).toHaveLength(0);
    });

    it('validates the value against its definition', async () => {
      const workshop = await locations.create({ name: 'Workshop' });
      const tools = await categories.create({ name: 'Power tools' });
      const rating = await categories.addField(tools.id, { name: 'Rating', fieldType: 'RATING' });
      // A location must never offer a value an inheriting item would reject.
      await expect(
        categories.setLocationFieldValue(workshop.id, { defId: rating.defId, value: '9' }),
      ).rejects.toThrow(DbError);
    });

    it('does not apply a category’s required-ness to a location’s value', async () => {
      const workshop = await locations.create({ name: 'Workshop' });
      const tools = await categories.create({ name: 'Power tools' });
      const field = await categories.addField(tools.id, {
        name: 'Manufacturer',
        fieldType: 'TEXT',
        isRequired: true,
      });
      // Required is the category's policy for items, not a constraint on the location.
      await expect(
        categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: '' }),
      ).resolves.not.toThrow();
    });
  });

  describe('item card values', () => {
    it('reports an inherited value alongside stored ones', async () => {
      const { drill, workshop, tools, field } = await scenario();
      const stored = await items.create({ name: 'Sander', categoryId: tools.id });
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE });
      await categories.setItemFieldValues(stored.id, { [field.id]: 'Makita' });

      // A card that omitted inherited values would read as missing data.
      const values = await categories.getItemFieldValues([drill.id, stored.id]);
      expect(values.get(drill.id)?.get(field.id)).toBe('Ryobi');
      expect(values.get(stored.id)?.get(field.id)).toBe('Makita');
    });
  });
});
