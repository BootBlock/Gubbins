import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';

describe('CategoryRepository', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates and lists categories with their field counts', async () => {
    const resistors = await categories.create({ name: 'Resistors' });
    await categories.create({ name: 'Capacitors' });
    await categories.addField(resistors.id, { name: 'Resistance', fieldType: 'NUMBER' });

    const page = await categories.list();
    expect(page.rows.map((c) => c.name)).toEqual(['Capacitors', 'Resistors']);
    const r = page.rows.find((c) => c.id === resistors.id);
    expect(r?.fieldCount).toBe(1);
  });

  it('rejects a blank category name', async () => {
    await expect(categories.create({ name: '   ' })).rejects.toBeInstanceOf(DbError);
  });

  it('renames a category', async () => {
    const cat = await categories.create({ name: 'Tols' });
    const updated = await categories.update(cat.id, { name: 'Tools' });
    expect(updated.name).toBe('Tools');
  });

  it('deletes a category and nulls the category on its items (no item loss)', async () => {
    const cat = await categories.create({ name: 'Doomed' });
    const item = await items.create({ name: 'Widget', categoryId: cat.id });

    await categories.delete(cat.id);

    expect(await categories.getById(cat.id)).toBeUndefined();
    const survivor = await items.getById(item.id);
    expect(survivor).toBeDefined();
    expect(survivor?.categoryId).toBeNull();
  });

  it('adds, orders, updates and removes custom fields', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, {
      name: 'Voltage',
      fieldType: 'NUMBER',
      isRequired: true,
      position: 1,
    });
    await categories.addField(cat.id, {
      name: 'Dielectric',
      fieldType: 'SELECT',
      options: ['X7R', 'C0G'],
      position: 0,
    });

    let fields = await categories.listFields(cat.id);
    expect(fields.map((f) => f.name)).toEqual(['Dielectric', 'Voltage']);
    expect(fields[0]?.options).toEqual(['X7R', 'C0G']);
    expect(fields[1]?.isRequired).toBe(true);

    await categories.updateField(voltage.id, { name: 'Rated voltage' });
    await categories.deleteField(fields[0]!.id);

    fields = await categories.listFields(cat.id);
    expect(fields.map((f) => f.name)).toEqual(['Rated voltage']);
  });

  it('rejects a SELECT field with no options', async () => {
    const cat = await categories.create({ name: 'Caps' });
    await expect(
      categories.addField(cat.id, { name: 'Dielectric', fieldType: 'SELECT' }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('resolves item fields with lenient defaulting for items lacking values', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'NUMBER' });
    await categories.addField(cat.id, {
      name: 'Package',
      fieldType: 'TEXT',
      defaultValue: '0805',
    });

    // An item created before any value is set: lenient defaulting must not error.
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    let resolved = await categories.resolveItemFields(item.id);
    const byName = Object.fromEntries(resolved.map((f) => [f.name, f]));
    expect(byName['Voltage']?.value).toBeNull();
    expect(byName['Voltage']?.hasStoredValue).toBe(false);
    expect(byName['Package']?.value).toBe('0805'); // default applied silently
    expect(byName['Package']?.hasStoredValue).toBe(false);

    await categories.setItemFieldValues(item.id, { [voltage.id]: '16' });
    resolved = await categories.resolveItemFields(item.id);
    const v = resolved.find((f) => f.id === voltage.id);
    expect(v?.value).toBe('16');
    expect(v?.hasStoredValue).toBe(true);
  });

  it('clears a stored value when set to null', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'NUMBER' });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await categories.setItemFieldValues(item.id, { [voltage.id]: '16' });
    await categories.setItemFieldValues(item.id, { [voltage.id]: null });

    const resolved = await categories.resolveItemFields(item.id);
    expect(resolved.find((f) => f.id === voltage.id)?.hasStoredValue).toBe(false);
  });

  it('rejects setting a value for a field outside the item’s category', async () => {
    const caps = await categories.create({ name: 'Caps' });
    const resistors = await categories.create({ name: 'Resistors' });
    const foreign = await categories.addField(resistors.id, { name: 'Resistance', fieldType: 'NUMBER' });
    const item = await items.create({ name: 'MLCC', categoryId: caps.id });

    await expect(categories.setItemFieldValues(item.id, { [foreign.id]: '10' })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('rejects an invalid NUMBER value (Phase 70 validation seam)', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'NUMBER' });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await expect(
      categories.setItemFieldValues(item.id, { [voltage.id]: 'not-a-number' }),
    ).rejects.toBeInstanceOf(DbError);
    // The rejected write must not have persisted anything.
    const resolved = await categories.resolveItemFields(item.id);
    expect(resolved.find((f) => f.id === voltage.id)?.hasStoredValue).toBe(false);
  });

  it('rejects a SELECT value outside the option list', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const dielectric = await categories.addField(cat.id, {
      name: 'Dielectric',
      fieldType: 'SELECT',
      options: ['X7R', 'C0G'],
    });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await expect(categories.setItemFieldValues(item.id, { [dielectric.id]: 'NP0' })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('rejects clearing a required field to blank', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, {
      name: 'Voltage',
      fieldType: 'NUMBER',
      isRequired: true,
    });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await expect(categories.setItemFieldValues(item.id, { [voltage.id]: '   ' })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('persists the CANONICAL coerced value (1.50 → 1.5)', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'NUMBER' });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await categories.setItemFieldValues(item.id, { [voltage.id]: '1.50' });
    const resolved = await categories.resolveItemFields(item.id);
    const v = resolved.find((f) => f.id === voltage.id);
    expect(v?.value).toBe('1.5');
    expect(v?.hasStoredValue).toBe(true);
  });

  it('still tombstones a clear-to-null after the validation seam', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'NUMBER' });
    const item = await items.create({ name: 'MLCC', categoryId: cat.id });

    await categories.setItemFieldValues(item.id, { [voltage.id]: '16' });
    await categories.setItemFieldValues(item.id, { [voltage.id]: null });

    const resolved = await categories.resolveItemFields(item.id);
    expect(resolved.find((f) => f.id === voltage.id)?.hasStoredValue).toBe(false);
    // A tombstone row exists so the deletion propagates on sync.
    const tomb = await driver.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'item_field_values';",
    );
    expect(Number(tomb?.n ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('honours the storage Hard Stop on growth writes but never on deletes', async () => {
    const locked = new CategoryRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.create({ name: 'Nope' })).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });

    // A pre-existing category can still be deleted to free space.
    const cat = await categories.create({ name: 'Temp' });
    const lockedDelete = new CategoryRepository(driver, { isWriteSuspended: () => true });
    await expect(lockedDelete.delete(cat.id)).resolves.toBeUndefined();
  });
});
