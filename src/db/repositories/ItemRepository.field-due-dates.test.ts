/**
 * `listFieldDueDates` — the read behind the custom-field due-date lanes (W1a).
 *
 * These are the parts only a real database exercises: the opt-in actually filtering, the read
 * going through the **effective-values view** so an inherited date counts, and the per-definition
 * window being computed in SQL. The pure classification of what comes back is covered in
 * `features/lifecycle/field-due.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from './CategoryRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { todayDateInputValue } from '@/lib/date-input';

/** Mid-afternoon on a fixed day; the SQL window is keyed on the *local* calendar day. */
const NOW = Date.parse('2026-06-30T15:00:00Z');

/** The `YYYY-MM-DD` value a user would pick `offset` days from today. */
function day(offset: number): string {
  const today = new Date(`${todayDateInputValue(NOW)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() + offset);
  return today.toISOString().slice(0, 10);
}

describe('ItemRepository.listFieldDueDates (W1a)', () => {
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

  /** A category with an opted-in "Renewal date" (14 days' notice) and one item in it. */
  async function scenario(dueLeadDays: number | null = 14) {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays,
    });
    const item = await items.create({ name: 'Studio insurance', categoryId: category.id });
    return { category, field, item };
  }

  it('returns a value whose definition opted in, naming both the item and the field', async () => {
    const { field, item } = await scenario();
    await categories.setItemFieldValues(item.id, { [field.id]: day(3) });

    const page = await items.listFieldDueDates(NOW);
    expect(page.rows).toEqual([
      {
        itemId: item.id,
        itemName: 'Studio insurance',
        defId: field.defId,
        fieldName: 'Renewal date',
        leadDays: 14,
        dueAt: Date.parse(day(3)),
      },
    ]);
  });

  it('ignores an ordinary DATE field — the opt-in is the whole gate', async () => {
    const { field, item } = await scenario(null);
    await categories.setItemFieldValues(item.id, { [field.id]: day(3) });
    expect((await items.listFieldDueDates(NOW)).rows).toEqual([]);
  });

  it("applies each definition's own lead time, not one shared window", async () => {
    const category = await categories.create({ name: 'Kit' });
    const soon = await categories.addField(category.id, {
      name: 'Return by',
      fieldType: 'DATE',
      dueLeadDays: 2,
    });
    const later = await categories.addField(category.id, {
      name: 'Calibration due',
      fieldType: 'DATE',
      dueLeadDays: 90,
    });
    const item = await items.create({ name: 'Multimeter', categoryId: category.id });
    // The same date, 30 days out: inside the calibration field's notice, outside the return-by's.
    await categories.setItemFieldValues(item.id, {
      [soon.id]: day(30),
      [later.id]: day(30),
    });

    const page = await items.listFieldDueDates(NOW);
    expect(page.rows.map((r) => r.fieldName)).toEqual(['Calibration due']);
  });

  it('includes a date that has already passed — an overdue deadline is the point', async () => {
    const { field, item } = await scenario(0);
    await categories.setItemFieldValues(item.id, { [field.id]: day(-40) });
    expect((await items.listFieldDueDates(NOW)).rows).toHaveLength(1);
  });

  it('excludes a date beyond the notice period, and includes its far edge', async () => {
    const { field, item } = await scenario(14);
    await categories.setItemFieldValues(item.id, { [field.id]: day(15) });
    expect((await items.listFieldDueDates(NOW)).rows).toEqual([]);

    await categories.setItemFieldValues(item.id, { [field.id]: day(14) });
    expect((await items.listFieldDueDates(NOW)).rows).toHaveLength(1);
  });

  it('reads through the effective-values view, so an inherited date still counts', async () => {
    // The base table stores NULL for an inheriting item; reading it directly would silently
    // miss every item that takes its date from a location (issue #97).
    const room = await locations.create({ name: 'Server room' });
    const category = await categories.create({ name: 'Certificates' });
    const field = await categories.addField(category.id, {
      name: 'Inspection due',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    const item = await items.create({
      name: 'Rack PDU',
      categoryId: category.id,
      locationId: room.id,
    });
    await categories.setLocationFieldValue(room.id, {
      defId: field.defId,
      value: day(5),
      isInheritable: true,
    });
    await categories.setItemFieldValues(item.id, { [field.id]: '<inherit>' });

    const page = await items.listFieldDueDates(NOW);
    expect(page.rows.map((r) => r.itemName)).toEqual(['Rack PDU']);
    expect(page.rows[0]!.dueAt).toBe(Date.parse(day(5)));
  });

  it('skips an inactive item — a deleted thing has no deadlines', async () => {
    const { field, item } = await scenario();
    await categories.setItemFieldValues(item.id, { [field.id]: day(1) });
    await items.softDelete(item.id);
    expect((await items.listFieldDueDates(NOW)).rows).toEqual([]);
  });

  it('honours an explicit horizon, which is how the agenda asks for everything scheduled', async () => {
    const { field, item } = await scenario(14);
    await categories.setItemFieldValues(item.id, { [field.id]: day(400) });

    expect((await items.listFieldDueDates(NOW)).rows).toEqual([]);
    expect((await items.listFieldDueDates(NOW, { withinDays: 36_500 })).rows).toHaveLength(1);
  });

  it('orders soonest first so a truncated page keeps the urgent end', async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 60,
    });
    for (const [name, offset] of [
      ['Late', 40],
      ['First', -2],
      ['Middle', 10],
    ] as const) {
      const item = await items.create({ name, categoryId: category.id });
      await categories.setItemFieldValues(item.id, { [field.id]: day(offset) });
    }
    const page = await items.listFieldDueDates(NOW);
    expect(page.rows.map((r) => r.itemName)).toEqual(['First', 'Middle', 'Late']);
  });

  it('pages, and reports hasMore so a caller can read the rest', async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 60,
    });
    for (let i = 0; i < 3; i += 1) {
      const item = await items.create({ name: `Policy ${i}`, categoryId: category.id });
      await categories.setItemFieldValues(item.id, { [field.id]: day(i) });
    }

    const first = await items.listFieldDueDates(NOW, { limit: 2, offset: 0 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await items.listFieldDueDates(NOW, { limit: 2, offset: 2 });
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('ignores a stored value that is not a real calendar day', async () => {
    // Values are validated on write, but a row can arrive from a peer or a restored snapshot.
    // A malformed one must be skipped, not string-compared against a real date — and note
    // `2026-02-30`, which SQLite's `date()` would happily normalise to 2 March if the query
    // merely asked whether it parsed.
    const { field, item } = await scenario(365);
    await categories.setItemFieldValues(item.id, { [field.id]: day(1) });
    // Sanity: the well-formed value the loop then corrupts *is* returned, so an empty result
    // below is the guard rejecting the bad value, not the scenario failing to match at all.
    expect((await items.listFieldDueDates(NOW)).rows).toHaveLength(1);
    for (const bad of ['not-a-date', '2026-02-30', 'now']) {
      await driver.execute('UPDATE item_field_values SET value = ? WHERE def_id = ?;', [bad, field.defId]);
      expect((await items.listFieldDueDates(NOW)).rows, bad).toEqual([]);
    }
  });
});

describe('CategoryRepository — the due-date opt-in itself (W1a)', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('refuses the opt-in on a field that is not a date', async () => {
    const category = await categories.create({ name: 'Policies' });
    await expect(
      categories.addField(category.id, { name: 'Provider', fieldType: 'TEXT', dueLeadDays: 14 }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('refuses a notice period outside the bounds the schema enforces', async () => {
    const category = await categories.create({ name: 'Policies' });
    for (const days of [-1, 366, 1.5]) {
      await expect(
        categories.addField(category.id, {
          name: `Renewal ${days}`,
          fieldType: 'DATE',
          dueLeadDays: days,
        }),
      ).rejects.toBeInstanceOf(DbError);
    }
  });

  it("carries the opt-in onto the category's view of the field, so the editor can show it", async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    expect(field.dueLeadDays).toBe(30);
    expect((await categories.listFields(category.id))[0]!.dueLeadDays).toBe(30);
    expect((await categories.listFieldDefs())[0]!.dueLeadDays).toBe(30);
  });

  it('shares the opt-in with every category using the field — it is a definition attribute', async () => {
    const policies = await categories.create({ name: 'Policies' });
    const gear = await categories.create({ name: 'Gear' });
    await categories.addField(policies.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    const shared = await categories.addField(gear.id, { name: 'Renewal date', fieldType: 'DATE' });
    expect(shared.dueLeadDays).toBe(30);
  });

  it('never clears a shared opt-in just because a second category did not tick the box', async () => {
    const policies = await categories.create({ name: 'Policies' });
    const gear = await categories.create({ name: 'Gear' });
    const first = await categories.addField(policies.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    await categories.addField(gear.id, { name: 'Renewal date', fieldType: 'DATE', dueLeadDays: null });
    expect((await categories.listFields(policies.id))[0]!.dueLeadDays).toBe(30);
    expect(first.dueLeadDays).toBe(30);
  });

  it('applies a tick to a definition that already exists, since the user is stating what it means', async () => {
    const policies = await categories.create({ name: 'Policies' });
    const gear = await categories.create({ name: 'Gear' });
    await categories.addField(policies.id, { name: 'Renewal date', fieldType: 'DATE' });
    await categories.addField(gear.id, { name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 7 });
    expect((await categories.listFields(policies.id))[0]!.dueLeadDays).toBe(7);
  });

  it('clears the opt-in when the field is retyped away from DATE', async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    const updated = await categories.updateField(field.id, { fieldType: 'TEXT' });
    expect(updated.fieldType).toBe('TEXT');
    expect(updated.dueLeadDays).toBeNull();
  });

  it('accepts opting in while retyping *to* DATE in the same edit', async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, { name: 'Renewal date', fieldType: 'TEXT' });
    const updated = await categories.updateField(field.id, { fieldType: 'DATE', dueLeadDays: 21 });
    expect(updated.dueLeadDays).toBe(21);
  });

  it('turns the opt-in off again when explicitly cleared', async () => {
    const category = await categories.create({ name: 'Policies' });
    const field = await categories.addField(category.id, {
      name: 'Renewal date',
      fieldType: 'DATE',
      dueLeadDays: 30,
    });
    expect((await categories.updateField(field.id, { dueLeadDays: null })).dueLeadDays).toBeNull();
  });
});
