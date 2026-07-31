import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MAX_FIELD_TAB_LABEL_LENGTH } from '@/features/inventory/field-prominence';
import { CategoryRepository } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { MaintenanceRepository } from './MaintenanceRepository';

describe('CategoryRepository', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;
  let items: ItemRepository;
  let maintenance: MaintenanceRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
    items = new ItemRepository(driver);
    maintenance = new MaintenanceRepository(driver);
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

  it('listAll returns every category, past the default page size (issue #148)', async () => {
    // `list` is capped by the strict page ceiling; the whole-set read the UI resolves category
    // names and picker options from must not be — a category missing from it renders an item with
    // no category at all and makes that category unpickable, rather than merely shortening a list.
    const created = 120;
    for (let i = 0; i < created; i += 1) {
      await categories.create({ name: `Kind ${String(i).padStart(3, '0')}` });
    }
    const withField = await categories.create({ name: 'Aardvarks' });
    await categories.addField(withField.id, { name: 'Snout length', fieldType: 'NUMBER' });

    const paged = await categories.list();
    const all = await categories.listAll();

    expect(paged.rows.length).toBeLessThan(created);
    expect(all.length).toBe(created + 1);
    // Same ordering and the same derived field counts as the paged read, so the two never disagree.
    expect(all.slice(0, paged.rows.length).map((c) => c.id)).toEqual(paged.rows.map((c) => c.id));
    expect(all.find((c) => c.id === withField.id)?.fieldCount).toBe(1);
  });

  it('rejects a blank category name', async () => {
    await expect(categories.create({ name: '   ' })).rejects.toBeInstanceOf(DbError);
  });

  it('renames a category', async () => {
    const cat = await categories.create({ name: 'Tols' });
    const updated = await categories.update(cat.id, { name: 'Tools' });
    expect(updated.name).toBe('Tools');
  });

  it('round-trips a category default tracking mode, defaulting to null (backlog T1)', async () => {
    // A category with no default reads back as null…
    const plain = await categories.create({ name: 'Odds & ends' });
    expect(plain.defaultTrackingMode).toBeNull();
    expect((await categories.getById(plain.id))?.defaultTrackingMode).toBeNull();

    // …and one created with a default carries it through create and read.
    const tools = await categories.create({ name: 'Tools', defaultTrackingMode: 'SERIALISED' });
    expect(tools.defaultTrackingMode).toBe('SERIALISED');
    expect((await categories.getById(tools.id))?.defaultTrackingMode).toBe('SERIALISED');
    // It also surfaces in the management list (CategoryWithFieldCount extends Category).
    const listed = (await categories.list()).rows.find((c) => c.id === tools.id);
    expect(listed?.defaultTrackingMode).toBe('SERIALISED');
  });

  it('round-trips, updates and clears an optional category glyph (issue #83)', async () => {
    // A category with no glyph reads back as null.
    const plain = await categories.create({ name: 'Odds & ends' });
    expect(plain.glyph).toBeNull();

    // One created with a glyph carries it through create, read and the management list.
    const batteries = await categories.create({ name: 'Batteries', glyph: '🔋' });
    expect(batteries.glyph).toBe('🔋');
    expect((await categories.getById(batteries.id))?.glyph).toBe('🔋');
    expect((await categories.list()).rows.find((c) => c.id === batteries.id)?.glyph).toBe('🔋');

    // Update just the glyph — the name is left untouched (partial LWW update).
    const changed = await categories.update(batteries.id, { glyph: '📖' });
    expect(changed.name).toBe('Batteries');
    expect(changed.glyph).toBe('📖');

    // Passing null clears it back to "no glyph".
    expect((await categories.update(batteries.id, { glyph: null })).glyph).toBeNull();
  });

  it('normalises a category glyph: trims, and treats blank as no glyph (issue #83)', async () => {
    const trimmed = await categories.create({ name: 'Spaced', glyph: '  🔋  ' });
    expect(trimmed.glyph).toBe('🔋');

    const blank = await categories.create({ name: 'Blank glyph', glyph: '   ' });
    expect(blank.glyph).toBeNull();

    // A blank update clears an existing glyph too.
    expect((await categories.update(trimmed.id, { glyph: '   ' })).glyph).toBeNull();
  });

  it('updates and clears a category default tracking mode without touching the name (backlog T1)', async () => {
    const cat = await categories.create({ name: 'Test gear', defaultTrackingMode: 'SERIALISED' });

    // Update just the default — the name is left untouched (partial LWW update).
    const set = await categories.update(cat.id, { defaultTrackingMode: 'UNTRACKED' });
    expect(set.name).toBe('Test gear');
    expect(set.defaultTrackingMode).toBe('UNTRACKED');

    // Passing null clears it back to "no default".
    const cleared = await categories.update(cat.id, { defaultTrackingMode: null });
    expect(cleared.defaultTrackingMode).toBeNull();
    expect(cleared.name).toBe('Test gear');
  });

  it('rejects a category default tracking mode outside the TRACKING_MODES SSOT (backlog T1)', async () => {
    await expect(
      // The DB CHECK mirrors items.tracking_mode, so a bogus mode is refused.
      categories.create({ name: 'Bad', defaultTrackingMode: 'BOGUS' as never }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('round-trips category default condition + warranty window, defaulting to null (backlog T2)', async () => {
    // A category with no lifecycle defaults reads them back as null.
    const plain = await categories.create({ name: 'Odds & ends' });
    expect(plain.defaultCondition).toBeNull();
    expect(plain.defaultWarrantyMonths).toBeNull();
    const readPlain = await categories.getById(plain.id);
    expect(readPlain?.defaultCondition).toBeNull();
    expect(readPlain?.defaultWarrantyMonths).toBeNull();

    // One created with the defaults carries them through create and read…
    const tools = await categories.create({
      name: 'Tools',
      defaultCondition: 'GOOD',
      defaultWarrantyMonths: 12,
    });
    expect(tools.defaultCondition).toBe('GOOD');
    expect(tools.defaultWarrantyMonths).toBe(12);
    const readTools = await categories.getById(tools.id);
    expect(readTools?.defaultCondition).toBe('GOOD');
    expect(readTools?.defaultWarrantyMonths).toBe(12);

    // …and they surface in the management list too (CategoryWithFieldCount extends Category).
    const listed = (await categories.list()).rows.find((c) => c.id === tools.id);
    expect(listed?.defaultCondition).toBe('GOOD');
    expect(listed?.defaultWarrantyMonths).toBe(12);
  });

  it('updates and clears the category default condition + warranty window independently (backlog T2)', async () => {
    const cat = await categories.create({
      name: 'Test gear',
      defaultCondition: 'GOOD',
      defaultWarrantyMonths: 12,
    });

    // Update just the condition — the warranty window and name are left untouched (partial LWW).
    const set = await categories.update(cat.id, { defaultCondition: 'MINT' });
    expect(set.name).toBe('Test gear');
    expect(set.defaultCondition).toBe('MINT');
    expect(set.defaultWarrantyMonths).toBe(12);

    // Update just the warranty window — the condition is left untouched.
    const rewindowed = await categories.update(cat.id, { defaultWarrantyMonths: 24 });
    expect(rewindowed.defaultCondition).toBe('MINT');
    expect(rewindowed.defaultWarrantyMonths).toBe(24);

    // Passing null clears each back to "no default".
    const cleared = await categories.update(cat.id, {
      defaultCondition: null,
      defaultWarrantyMonths: null,
    });
    expect(cleared.defaultCondition).toBeNull();
    expect(cleared.defaultWarrantyMonths).toBeNull();
    expect(cleared.name).toBe('Test gear');
  });

  it('rejects a category default condition outside the CONDITIONS SSOT (backlog T2)', async () => {
    await expect(
      // The DB CHECK mirrors items.condition, so a bogus condition is refused.
      categories.create({ name: 'Bad', defaultCondition: 'PRISTINE' as never }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('rejects a non-positive category default warranty window (backlog T2)', async () => {
    await expect(
      // A warranty *window* must be a positive number of months (CHECK ... > 0).
      categories.create({ name: 'Bad', defaultWarrantyMonths: 0 }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('round-trips the category default maintenance schedule through create/update/list (backlog T2a)', async () => {
    // No default reads back as three nulls.
    const plain = await categories.create({ name: 'Odds & ends' });
    expect(plain.defaultMaintenanceBasis).toBeNull();
    expect(plain.defaultMaintenanceIntervalDays).toBeNull();
    expect(plain.defaultMaintenanceIntervalUsage).toBeNull();

    // A TIME default carries basis + day interval through create, read and list.
    const tools = await categories.create({
      name: 'Tools',
      defaultMaintenanceBasis: 'TIME',
      defaultMaintenanceIntervalDays: 365,
    });
    expect(tools.defaultMaintenanceBasis).toBe('TIME');
    expect(tools.defaultMaintenanceIntervalDays).toBe(365);
    expect(tools.defaultMaintenanceIntervalUsage).toBeNull();
    const listed = (await categories.list()).rows.find((c) => c.id === tools.id);
    expect(listed?.defaultMaintenanceBasis).toBe('TIME');
    expect(listed?.defaultMaintenanceIntervalDays).toBe(365);

    // Switching to a USAGE default (basis + usage interval, TIME interval nulled).
    const reused = await categories.update(tools.id, {
      defaultMaintenanceBasis: 'USAGE',
      defaultMaintenanceIntervalDays: null,
      defaultMaintenanceIntervalUsage: 100,
    });
    expect(reused.defaultMaintenanceBasis).toBe('USAGE');
    expect(reused.defaultMaintenanceIntervalDays).toBeNull();
    expect(reused.defaultMaintenanceIntervalUsage).toBe(100);
    expect(reused.name).toBe('Tools'); // partial LWW — the name is untouched

    // Clearing the basis clears the schedule default.
    const cleared = await categories.update(tools.id, {
      defaultMaintenanceBasis: null,
      defaultMaintenanceIntervalDays: null,
      defaultMaintenanceIntervalUsage: null,
    });
    expect(cleared.defaultMaintenanceBasis).toBeNull();
    expect(cleared.defaultMaintenanceIntervalUsage).toBeNull();
  });

  it('rejects a category default maintenance basis outside the MAINTENANCE_BASES SSOT (backlog T2a)', async () => {
    await expect(
      categories.create({ name: 'Bad', defaultMaintenanceBasis: 'MILEAGE' as never }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('applies a category default TIME schedule to an item on create (backlog T2a)', async () => {
    const tools = await categories.create({
      name: 'Tools',
      defaultMaintenanceBasis: 'TIME',
      defaultMaintenanceIntervalDays: 365,
    });
    const drill = await items.create({ name: 'Cordless drill', categoryId: tools.id });

    const schedules = await maintenance.listForItem(drill.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.basis).toBe('TIME');
    expect(schedules[0]?.intervalDays).toBe(365);
    expect(schedules[0]?.intervalUsage).toBeNull();
  });

  it('applies a category default USAGE schedule to an item on create (backlog T2a)', async () => {
    const gear = await categories.create({
      name: 'Test gear',
      defaultMaintenanceBasis: 'USAGE',
      defaultMaintenanceIntervalUsage: 100,
    });
    const meter = await items.create({ name: 'Insulation tester', categoryId: gear.id });

    const schedules = await maintenance.listForItem(meter.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.basis).toBe('USAGE');
    expect(schedules[0]?.intervalUsage).toBe(100);
    expect(schedules[0]?.intervalDays).toBeNull();
  });

  it('creates no schedule for a category without a maintenance default, or one only half-configured (backlog T2a)', async () => {
    // No basis at all → nothing.
    const plain = await categories.create({ name: 'Odds & ends' });
    const widget = await items.create({ name: 'Widget', categoryId: plain.id });
    expect(await maintenance.listForItem(widget.id)).toHaveLength(0);

    // A basis without its matching interval is a no-op (the application requires both).
    const halfTime = await categories.create({ name: 'Half time', defaultMaintenanceBasis: 'TIME' });
    const gadget = await items.create({ name: 'Gadget', categoryId: halfTime.id });
    expect(await maintenance.listForItem(gadget.id)).toHaveLength(0);

    // An item with no category at all is likewise untouched.
    const orphan = await items.create({ name: 'Uncategorised' });
    expect(await maintenance.listForItem(orphan.id)).toHaveLength(0);
  });

  it('applies the category default schedule to every serialised instance on create (backlog T2a)', async () => {
    const tools = await categories.create({
      name: 'Tools',
      defaultMaintenanceBasis: 'TIME',
      defaultMaintenanceIntervalDays: 365,
    });
    const drills = await items.createSerialised({
      name: 'Cordless drill',
      categoryId: tools.id,
      trackingMode: 'SERIALISED',
      count: 3,
    });
    expect(drills).toHaveLength(3);
    for (const drill of drills) {
      const schedules = await maintenance.listForItem(drill.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.intervalDays).toBe(365);
    }
  });

  it('honours the category default schedule on a bulk createMany (import path) (backlog T2a)', async () => {
    const tools = await categories.create({
      name: 'Tools',
      defaultMaintenanceBasis: 'TIME',
      defaultMaintenanceIntervalDays: 365,
    });
    const plain = await categories.create({ name: 'Consumables' });
    const [drill, tape, loose] = await items.createMany([
      { name: 'Drill', categoryId: tools.id },
      { name: 'PTFE tape', categoryId: plain.id },
      { name: 'Uncategorised' },
    ]);

    // Only the item in the schedule-bearing category gets one.
    expect(await maintenance.listForItem(drill!.id)).toHaveLength(1);
    expect(await maintenance.listForItem(tape!.id)).toHaveLength(0);
    expect(await maintenance.listForItem(loose!.id)).toHaveLength(0);
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

  it('persists and clears a field description', async () => {
    const cat = await categories.create({ name: 'Caps' });
    const field = await categories.addField(cat.id, {
      name: 'Voltage',
      fieldType: 'NUMBER',
      description: 'Read from the label on the base — in volts.',
    });
    expect(field.description).toBe('Read from the label on the base — in volts.');

    // A field added with no description has a null one.
    const bare = await categories.addField(cat.id, { name: 'Package', fieldType: 'TEXT' });
    expect(bare.description).toBeNull();

    // The description can be edited and cleared independently.
    const edited = await categories.updateField(field.id, { description: 'Different note.' });
    expect(edited.description).toBe('Different note.');
    const cleared = await categories.updateField(field.id, { description: null });
    expect(cleared.description).toBeNull();
  });

  it('rejects a SELECT field with no options', async () => {
    const cat = await categories.create({ name: 'Caps' });
    await expect(
      categories.addField(cat.id, { name: 'Dielectric', fieldType: 'SELECT' }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('reuses one definition for names differing only by non-ASCII case (issue #343)', async () => {
    // SQLite's NOCASE folds A–Z only, so the unique index alone would let these fork the
    // dictionary in two — and a location offering "Größe" would then reach the items of one
    // category and silently miss the other's.
    const caps = await categories.create({ name: 'Caps' });
    const resistors = await categories.create({ name: 'Resistors' });
    const first = await categories.addField(caps.id, { name: 'Größe', fieldType: 'TEXT' });
    const second = await categories.addField(resistors.id, { name: 'GRÖSSE', fieldType: 'TEXT' });

    expect(second.defId).toBe(first.defId);
    const defs = await driver.query<{ id: string }>('SELECT id FROM field_defs;');
    expect(defs).toHaveLength(1);
  });

  it('refuses a retype through a non-ASCII case variant of an existing field (issue #343)', async () => {
    const cat = await categories.create({ name: 'Caps' });
    await categories.addField(cat.id, { name: 'Café', fieldType: 'TEXT' });
    await expect(categories.addField(cat.id, { name: 'CAFÉ', fieldType: 'NUMBER' })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('refuses a rename onto a non-ASCII case variant of another field (issue #343)', async () => {
    const cat = await categories.create({ name: 'Caps' });
    await categories.addField(cat.id, { name: 'Größe', fieldType: 'TEXT' });
    const other = await categories.addField(cat.id, { name: 'Farbe', fieldType: 'TEXT' });

    await expect(categories.updateField(other.id, { name: 'GRÖSSE' })).rejects.toBeInstanceOf(DbError);
    // Its own name in a different case is not a clash with itself.
    const renamed = await categories.updateField(other.id, { name: 'FARBE' });
    expect(renamed.name).toBe('FARBE');
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

  // --- E1 item-card field reads (bulk catalog + values) --------------------------

  it('lists every custom field across all categories (the card-field catalog)', async () => {
    const resistors = await categories.create({ name: 'Resistors' });
    const caps = await categories.create({ name: 'Capacitors' });
    await categories.addField(resistors.id, { name: 'Resistance', fieldType: 'NUMBER' });
    await categories.addField(caps.id, { name: 'Voltage', fieldType: 'NUMBER' });

    const all = await categories.listAllFields();
    expect(all.map((f) => f.name).sort()).toEqual(['Resistance', 'Voltage']);
    // Grouped by category so the catalog is stable and browsable.
    expect(new Set(all.map((f) => f.categoryId))).toEqual(new Set([resistors.id, caps.id]));
  });

  it('bulk-reads stored field values for a set of items (only stored rows, per item)', async () => {
    const cat = await categories.create({ name: 'Resistors' });
    const voltage = await categories.addField(cat.id, { name: 'Voltage', fieldType: 'TEXT' });
    const a = await items.create({ name: 'R1', categoryId: cat.id });
    const b = await items.create({ name: 'R2', categoryId: cat.id });
    const c = await items.create({ name: 'R3', categoryId: cat.id }); // no stored value
    await categories.setItemFieldValues(a.id, { [voltage.id]: '5V' });
    await categories.setItemFieldValues(b.id, { [voltage.id]: '12V' });

    const values = await categories.getItemFieldValues([a.id, b.id, c.id]);
    expect(values.get(a.id)?.get(voltage.id)).toBe('5V');
    expect(values.get(b.id)?.get(voltage.id)).toBe('12V');
    // An item with no stored value simply has no entry (lenient defaulting happens at render).
    expect(values.has(c.id)).toBe(false);
  });

  it('returns an empty map (no query) for no item ids', async () => {
    expect((await categories.getItemFieldValues([])).size).toBe(0);
  });

  /**
   * Custom-field prominence (issue #619) — a presentational preference, stored with the same
   * discipline as `hidden_capabilities`: one canonical spelling of "no preference" so an LWW
   * merge can't mistake a no-op for an edit, and unrecognised values kept verbatim so a peer on
   * a newer version doesn't have its choice discarded by a round-trip through this build.
   */
  describe('custom-field prominence (issue #619)', () => {
    it('defaults to no preference', async () => {
      const cat = await categories.create({ name: 'Fasteners' });
      expect(cat.fieldProminence).toBeNull();
      expect(cat.fieldTabLabel).toBeNull();
    });

    it('round-trips a mode and a label through create', async () => {
      const cat = await categories.create({
        name: 'Movie',
        fieldProminence: 'own-tab',
        fieldTabLabel: 'Film details',
      });
      expect(cat.fieldProminence).toBe('own-tab');
      expect(cat.fieldTabLabel).toBe('Film details');
      // …and through the read the whole UI actually uses.
      const listed = (await categories.listAll()).find((c) => c.id === cat.id);
      expect(listed?.fieldProminence).toBe('own-tab');
      expect(listed?.fieldTabLabel).toBe('Film details');
    });

    it('round-trips a mode and a label through update', async () => {
      const cat = await categories.create({ name: 'Vinyl record' });
      const updated = await categories.update(cat.id, {
        fieldProminence: 'promoted',
        fieldTabLabel: 'Pressing',
      });
      expect(updated.fieldProminence).toBe('promoted');
      expect(updated.fieldTabLabel).toBe('Pressing');
    });

    it('stores the default mode as NULL, so "no preference" has one spelling', async () => {
      const cat = await categories.create({ name: 'Book', fieldProminence: 'default' });
      expect(cat.fieldProminence).toBeNull();
      const back = await categories.update(cat.id, { fieldProminence: 'default' });
      expect(back.fieldProminence).toBeNull();
    });

    it('stores a blank or whitespace label as NULL, for the same reason', async () => {
      const cat = await categories.create({ name: 'Coin', fieldTabLabel: '   ' });
      expect(cat.fieldTabLabel).toBeNull();
    });

    it('trims and caps a label, so an imported value cannot deform the tab rail', async () => {
      const cat = await categories.create({ name: 'Stamp', fieldTabLabel: `  ${'A'.repeat(60)}  ` });
      expect(cat.fieldTabLabel).toBe('A'.repeat(MAX_FIELD_TAB_LABEL_LENGTH));
    });

    it('keeps a mode it does not recognise, rather than rejecting or discarding it', async () => {
      // A newer peer may add a fourth position. Storage is not the boundary that judges it —
      // the render seam reads it as `default` and this device writes it back untouched.
      const cat = await categories.create({ name: 'Poster', fieldProminence: 'floating-panel' });
      expect(cat.fieldProminence).toBe('floating-panel');
    });

    it('leaves both columns alone when an update mentions neither', async () => {
      const cat = await categories.create({
        name: 'Blu-rays',
        fieldProminence: 'own-tab',
        fieldTabLabel: 'Disc details',
      });
      const renamed = await categories.update(cat.id, { name: 'Blu-ray discs' });
      expect(renamed.fieldProminence).toBe('own-tab');
      expect(renamed.fieldTabLabel).toBe('Disc details');
    });

    it('keeps the label when the mode returns to the default, so a switch back restores it', async () => {
      const cat = await categories.create({
        name: 'Video games',
        fieldProminence: 'own-tab',
        fieldTabLabel: 'Game details',
      });
      const off = await categories.update(cat.id, { fieldProminence: 'default' });
      expect(off.fieldTabLabel).toBe('Game details');
      const on = await categories.update(cat.id, { fieldProminence: 'own-tab' });
      expect(on.fieldTabLabel).toBe('Game details');
    });

    it('clears a label on an explicit null', async () => {
      const cat = await categories.create({ name: 'DVDs', fieldTabLabel: 'Disc details' });
      expect((await categories.update(cat.id, { fieldTabLabel: null })).fieldTabLabel).toBeNull();
    });
  });
});

/**
 * The Category facet's "in use" set (issue #76): the inventory Category picker offers only
 * categories that an active item currently uses (optionally within a location scope), so an
 * emptied category drops out and a re-used one comes back — the declutter that keeps the picker
 * honest, mirroring the status-chip applicability.
 */
describe('ItemRepository.categoriesInUse (issue #76)', () => {
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

  it('returns only categories used by at least one active item', async () => {
    const used = await categories.create({ name: 'Batteries' });
    await categories.create({ name: 'Unused' });
    await items.create({ name: 'AA cell', categoryId: used.id });
    await items.create({ name: 'Uncategorised' }); // contributes nothing (NULL category)

    expect(await items.categoriesInUse()).toEqual([used.id]);
  });

  it('drops a category once its last item leaves, and brings it back on re-use', async () => {
    const cat = await categories.create({ name: 'Batteries' });
    const other = await categories.create({ name: 'Widgets' });
    const item = await items.create({ name: 'AA cell', categoryId: cat.id });
    expect(await items.categoriesInUse()).toEqual([cat.id]);

    // Move the only item to another category → the old one is no longer in use.
    await items.update(item.id, { categoryId: other.id });
    expect(await items.categoriesInUse()).toEqual([other.id]);

    // Clear the category entirely → nothing is in use.
    await items.update(item.id, { categoryId: null });
    expect(await items.categoriesInUse()).toEqual([]);

    // Put it back → it reappears.
    await items.update(item.id, { categoryId: cat.id });
    expect(await items.categoriesInUse()).toEqual([cat.id]);
  });

  it('excludes categories whose only items are soft-deleted', async () => {
    const cat = await categories.create({ name: 'Batteries' });
    const item = await items.create({ name: 'AA cell', categoryId: cat.id });
    await items.softDelete(item.id);
    expect(await items.categoriesInUse()).toEqual([]);
  });

  it('scopes the in-use set to a location when one is given', async () => {
    const shed = await locations.create({ name: 'Shed' });
    const garage = await locations.create({ name: 'Garage' });
    const shedCat = await categories.create({ name: 'ShedCat' });
    const garageCat = await categories.create({ name: 'GarageCat' });
    await items.create({ name: 'Shovel', categoryId: shedCat.id, locationId: shed.id });
    await items.create({ name: 'Jack', categoryId: garageCat.id, locationId: garage.id });

    expect(await items.categoriesInUse(shed.id)).toEqual([shedCat.id]);
    expect(await items.categoriesInUse(garage.id)).toEqual([garageCat.id]);
    // No scope → both categories are in use across the whole inventory.
    expect((await items.categoriesInUse()).sort()).toEqual([garageCat.id, shedCat.id].sort());
  });
});
