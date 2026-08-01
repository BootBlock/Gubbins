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

  // Issue #617 (`N2`): the haystack the sidebar's location search matches against.
  describe('the searchable text of a location’s field values', () => {
    it('joins a location’s values with newlines, keyed by location', async () => {
      const { workshop, cabinet, field } = await scenario();
      const tools = await categories.create({ name: 'Storage' });
      const access = await categories.addField(tools.id, { name: 'Access note', fieldType: 'TEXT' });
      await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: 'Ryobi' });
      await categories.setLocationFieldValue(workshop.id, {
        defId: access.defId,
        value: 'Key in the kitchen drawer',
      });
      await categories.setLocationFieldValue(cabinet.id, { defId: field.defId, value: 'Makita' });

      const byLocation = await categories.listLocationFieldSearchText();
      // Ordered by field name, so "Access note" precedes "Manufacturer".
      expect(byLocation.get(workshop.id)).toBe('Key in the kitchen drawer\nRyobi');
      expect(byLocation.get(cabinet.id)).toBe('Makita');
    });

    it('omits a location whose only values are blank or unset', async () => {
      const { workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: '   ' });
      expect((await categories.listLocationFieldSearchText()).has(workshop.id)).toBe(false);
    });

    it('excludes an IMAGE value — it is a base64 picture, not words about the place', async () => {
      const workshop = await locations.create({ name: 'Workshop' });
      const kinds = await categories.create({ name: 'Rooms' });
      const photo = await categories.addField(kinds.id, { name: 'Shelf photo', fieldType: 'IMAGE' });
      const note = await categories.addField(kinds.id, { name: 'Zone', fieldType: 'TEXT' });
      await categories.setLocationFieldValue(workshop.id, {
        defId: photo.defId,
        value: 'data:image/webp;base64,AAAA',
      });
      await categories.setLocationFieldValue(workshop.id, { defId: note.defId, value: 'North wall' });

      expect((await categories.listLocationFieldSearchText()).get(workshop.id)).toBe('North wall');
    });

    it('drops a location’s entry once its last value is removed', async () => {
      const { workshop, field } = await scenario();
      await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: 'Ryobi' });
      await categories.removeLocationFieldValue(workshop.id, field.defId);
      expect(await categories.listLocationFieldSearchText()).toEqual(new Map());
    });
  });

  describe('removing a field from a category', () => {
    it("clears the stored values of that category's items", async () => {
      const { drill, tools, field } = await scenario();
      await categories.setItemFieldValues(drill.id, { [field.id]: 'Makita' });

      // Values key on the definition, so nothing cascades — deleteField must clear them
      // explicitly or they would linger invisibly and resurrect on a re-add.
      await categories.deleteField(field.id);
      await categories.addField(tools.id, { name: 'Manufacturer', fieldType: 'TEXT' });

      const [resolved] = await categories.resolveItemFields(drill.id);
      expect(resolved?.value).toBeNull();
    });

    it("leaves an item's value alone when it sits under another category", async () => {
      const { drill, field } = await scenario();
      const spares = await categories.create({ name: 'Spares' });
      const spareField = await categories.addField(spares.id, { name: 'Manufacturer', fieldType: 'TEXT' });
      const bit = await items.create({ name: 'Drill bit', categoryId: spares.id });
      await categories.setItemFieldValues(drill.id, { [field.id]: 'Makita' });
      await categories.setItemFieldValues(bit.id, { [spareField.id]: 'Bosch' });

      // Removing the field from Power tools must not touch Spares' items.
      await categories.deleteField(field.id);
      expect((await categories.resolveItemFields(bit.id))[0]?.value).toBe('Bosch');
    });
  });

  describe('guards on a shared definition', () => {
    it('refuses to retype a definition another category also uses', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const spares = await categories.create({ name: 'Spares' });
      const a = await categories.addField(tools.id, { name: 'Rating', fieldType: 'TEXT' });
      await categories.addField(spares.id, { name: 'Rating', fieldType: 'TEXT' });

      // Retyping would reinterpret every value stored under Spares, a category the user
      // is not looking at — the same reasoning that makes addField reject the mismatch.
      await expect(categories.updateField(a.id, { fieldType: 'NUMBER' })).rejects.toThrow(DbError);
    });

    it('allows retyping a definition only this category uses', async () => {
      const tools = await categories.create({ name: 'Power tools' });
      const only = await categories.addField(tools.id, { name: 'Rating', fieldType: 'TEXT' });
      const updated = await categories.updateField(only.id, { fieldType: 'NUMBER' });
      expect(updated.fieldType).toBe('NUMBER');
    });

    it('refuses to inherit a blank into a required field', async () => {
      const workshop = await locations.create({ name: 'Workshop' });
      const tools = await categories.create({ name: 'Power tools' });
      const field = await categories.addField(tools.id, {
        name: 'Manufacturer',
        fieldType: 'TEXT',
        isRequired: true,
      });
      const drill = await items.create({ name: 'Drill', categoryId: tools.id, locationId: workshop.id });
      // The location may hold a blank (required-ness is the category's policy for items),
      // so inheriting it would slip a required field past validation.
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: '',
        isInheritable: true,
      });
      await expect(categories.setItemFieldValues(drill.id, { [field.id]: INHERIT_VALUE })).rejects.toThrow(
        DbError,
      );
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
      expect(values.get(drill.id)?.get(field.id)?.value).toBe('Ryobi');
      expect(values.get(stored.id)?.get(field.id)?.value).toBe('Makita');
    });
  });

  describe('pruning unused definitions', () => {
    it('reports nothing while the definition is still used by a category', async () => {
      const { field } = await scenario();
      expect(await categories.listUnusedFieldDefs()).toEqual([]);
      // …and refuses to delete it even if asked directly.
      expect(await categories.deleteUnusedFieldDef(field.defId)).toBe(false);
      expect(await categories.listFieldDefs()).toHaveLength(1);
    });

    it('surfaces the definition once its last category use is dropped', async () => {
      const { field } = await scenario();
      await categories.deleteField(field.id);

      // deleteField deliberately keeps the definition (shared vocabulary), which is exactly
      // how an unreferenced one comes to exist.
      expect(await categories.listFieldDefs()).toHaveLength(1);
      const unused = await categories.listUnusedFieldDefs();
      expect(unused.map((d) => d.name)).toEqual(['Manufacturer']);

      expect(await categories.deleteUnusedFieldDef(field.defId)).toBe(true);
      expect(await categories.listFieldDefs()).toEqual([]);
    });

    it('keeps a definition a location still sets a value for', async () => {
      const { field, workshop } = await scenario();
      await categories.setLocationFieldValue(workshop.id, {
        defId: field.defId,
        value: 'Ryobi',
        isInheritable: true,
      });
      await categories.deleteField(field.id);

      // No category uses it any more, but the location's offer does — removing it here would
      // silently delete that value.
      expect(await categories.listUnusedFieldDefs()).toEqual([]);
      expect(await categories.deleteUnusedFieldDef(field.defId)).toBe(false);
    });

    it('keeps a definition an item still stores a value against', async () => {
      const { field, drill, tools } = await scenario();
      await categories.setItemFieldValues(drill.id, { [field.id]: 'Makita' });
      // Uncategorise the item so its value outlives the category's use of the field.
      await items.update(drill.id, { categoryId: null });
      await categories.deleteField(field.id);

      expect(await categories.listUnusedFieldDefs()).toEqual([]);
      expect(await categories.deleteUnusedFieldDef(field.defId)).toBe(false);
      expect(tools.id).toBeTruthy();
    });

    it('leaves no tombstone behind when it declines to delete an in-use definition', async () => {
      const { field } = await scenario();
      // Still used by its category, so the delete matches nothing.
      expect(await categories.deleteUnusedFieldDef(field.defId)).toBe(false);

      // A tombstone written regardless would tell peers to drop a definition that is still
      // here — the deletion and its marker must agree.
      const tomb = await driver.queryOne(
        "SELECT 1 FROM tombstones WHERE table_name = 'field_defs' AND id = ?;",
        [field.defId],
      );
      expect(tomb).toBeUndefined();
    });

    it('tombstones the removal so a peer does not re-download the definition', async () => {
      const { field } = await scenario();
      await categories.deleteField(field.id);
      await categories.deleteUnusedFieldDef(field.defId);

      const tomb = await driver.queryOne<{ id: string }>(
        "SELECT id FROM tombstones WHERE table_name = 'field_defs' AND id = ?;",
        [field.defId],
      );
      expect(tomb?.id).toBe(field.defId);
    });
  });
});

/**
 * W1g — the device a custom-field value was authored on, end-to-end through a real database.
 *
 * The routing rules are unit-tested in the pure `location-inheritance` seam; these cover what
 * only SQL exercises: the `ON CONFLICT` re-stamp guard, and that an inherited value's origin
 * comes off the location's row.
 */
describe('CategoryRepository — custom-field value attribution (#621, W1g)', () => {
  const THIS_DEVICE = 'device-this';
  const OTHER_DEVICE = 'device-other';
  const PATH = '\\\\server\\share\\boiler.pdf';

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

  /** A category with one FILE field, and an item in a cabinet inside a workshop. */
  async function scenario() {
    const workshop = await locations.create({ name: 'Workshop' });
    const cabinet = await locations.create({ name: 'Cabinet A', parentId: workshop.id });
    const boilers = await categories.create({ name: 'Boilers' });
    const field = await categories.addField(boilers.id, { name: 'Manual', fieldType: 'FILE' });
    const boiler = await items.create({ name: 'Boiler', categoryId: boilers.id, locationId: cabinet.id });
    return { workshop, cabinet, boilers, field, boiler };
  }

  const storedOrigin = (itemId: string) =>
    driver.queryOne<{ origin_device_id: string | null }>(
      'SELECT origin_device_id FROM item_field_values WHERE item_id = ?;',
      [itemId],
    );

  it('stamps the writing device on a value it authors', async () => {
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, THIS_DEVICE);
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBe(THIS_DEVICE);
  });

  it('leaves a value unattributed when the caller makes no claim', async () => {
    // A clone and a spreadsheet import both take this path: they copy a string rather than
    // authoring it, so they must not assert it resolves on the device doing the copying.
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH });
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBeNull();
  });

  it('does not re-stamp a value that was re-sent unchanged', async () => {
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, OTHER_DEVICE);
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, THIS_DEVICE);
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBe(OTHER_DEVICE);
  });

  /**
   * The item-table half of why the re-stamp is guarded. A CSV import re-states **every** field
   * value on a row it matched — unchanged ones included — and claims nothing, so an
   * unconditional assignment would push NULL over a good attribution and quietly downgrade a
   * marked foreign path to an unmarked one.
   */
  it('does not erase an existing origin when an unattributed writer re-sends the same value', async () => {
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, OTHER_DEVICE);
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH });
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBe(OTHER_DEVICE);
  });

  it('does erase it when that writer supplies a genuinely different value', async () => {
    // The counterpart: an import that *changes* the path has replaced what was attributed, so
    // keeping the old device would attribute a string it never wrote.
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, OTHER_DEVICE);
    await categories.setItemFieldValues(boiler.id, { [field.id]: 'D:\\manuals\\boiler.pdf' });
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBeNull();
  });

  it('re-stamps when the value actually changes — which is what re-linking is', async () => {
    const { field, boiler } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, OTHER_DEVICE);
    await categories.setItemFieldValues(boiler.id, { [field.id]: 'D:\\manuals\\boiler.pdf' }, THIS_DEVICE);
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBe(THIS_DEVICE);
  });

  it('clears the origin when a field switches to inheriting, leaving nothing stale behind', async () => {
    const { field, boiler, workshop } = await scenario();
    await categories.setItemFieldValues(boiler.id, { [field.id]: PATH }, OTHER_DEVICE);
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: '\\\\nas\\docs\\boiler.pdf',
      isInheritable: true,
    });
    await categories.setItemFieldValues(boiler.id, { [field.id]: INHERIT_VALUE });

    // An inherit row holds no value, so it has nothing of its own to attribute.
    expect((await storedOrigin(boiler.id))?.origin_device_id).toBeNull();
  });

  it('reports an inherited value origin from the location that offers it', async () => {
    const { field, boiler, workshop } = await scenario();
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      isInheritable: true,
      originDeviceId: OTHER_DEVICE,
    });
    await categories.setItemFieldValues(boiler.id, { [field.id]: INHERIT_VALUE });

    const [resolved] = await categories.resolveItemFields(boiler.id);
    expect(resolved?.source).toBe('inherited');
    expect(resolved?.originDeviceId).toBe(OTHER_DEVICE);
  });

  it('carries the origin onto the card read, inherited values included', async () => {
    const { field, boiler, workshop } = await scenario();
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      isInheritable: true,
      originDeviceId: OTHER_DEVICE,
    });
    await categories.setItemFieldValues(boiler.id, { [field.id]: INHERIT_VALUE });

    const byItem = await categories.getItemFieldValues([boiler.id]);
    expect(byItem.get(boiler.id)?.get(field.id)).toEqual({ value: PATH, originDeviceId: OTHER_DEVICE });
  });

  /**
   * A location's *Offer to items here* tick is saved through this same upsert, re-sending the
   * value untouched — so the guard has to hold on this table too, or ticking a box re-homes the
   * path for every item inheriting it.
   */
  it('does not re-stamp a location value when only its inheritable flag changes', async () => {
    const { field, workshop } = await scenario();
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      isInheritable: false,
      originDeviceId: OTHER_DEVICE,
    });
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      isInheritable: true,
      originDeviceId: THIS_DEVICE,
    });

    const [stored] = await categories.listLocationFieldValues(workshop.id);
    expect(stored?.isInheritable).toBe(true);
    expect(stored?.originDeviceId).toBe(OTHER_DEVICE);
  });

  it('re-stamps a location value whose text the user replaced', async () => {
    const { field, workshop } = await scenario();
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      originDeviceId: OTHER_DEVICE,
    });
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: 'D:\\manuals\\boiler.pdf',
      originDeviceId: THIS_DEVICE,
    });

    const [stored] = await categories.listLocationFieldValues(workshop.id);
    expect(stored?.originDeviceId).toBe(THIS_DEVICE);
  });

  /**
   * `IS` rather than `=` in the re-stamp guard: SQLite's `=` yields unknown against NULL, so a
   * value cleared to NULL and then set again would compare as "unchanged" and keep a stale
   * origin — the one case a plain equality test gets wrong.
   */
  it('re-stamps a location value set again after being cleared to blank', async () => {
    const { field, workshop } = await scenario();
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      originDeviceId: OTHER_DEVICE,
    });
    await categories.setLocationFieldValue(workshop.id, { defId: field.defId, value: '' });
    await categories.setLocationFieldValue(workshop.id, {
      defId: field.defId,
      value: PATH,
      originDeviceId: THIS_DEVICE,
    });

    const [stored] = await categories.listLocationFieldValues(workshop.id);
    expect(stored?.value).toBe(PATH);
    expect(stored?.originDeviceId).toBe(THIS_DEVICE);
  });
});
