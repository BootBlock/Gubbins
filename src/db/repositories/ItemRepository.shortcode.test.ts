import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { shortId } from '@/features/inventory/labels/label-template';
import { ItemRepository } from './ItemRepository';

/**
 * Short-code lookup (issue #338) — resolving the fallback identifier printed on every label
 * back to its item, so the printed line is an identifier rather than an ornament.
 */
describe('ItemRepository — findByShortCode', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('finds the item whose printed short code was typed, in either case', async () => {
    const item = await items.create({ name: 'Widget' });
    const code = shortId(item.id);
    expect((await items.findByShortCode(code)).map((i) => i.id)).toEqual([item.id]);
    expect((await items.findByShortCode(code.toLowerCase())).map((i) => i.id)).toEqual([item.id]);
    expect((await items.findByShortCode(`  ${code}  `)).map((i) => i.id)).toEqual([item.id]);
  });

  it('returns nothing for a code no item carries', async () => {
    await items.create({ name: 'Widget' });
    expect(await items.findByShortCode('DEADBEEF')).toEqual([]);
  });

  it('never returns a soft-deleted item', async () => {
    const item = await items.create({ name: 'Gone' });
    await items.softDelete(item.id);
    expect(await items.findByShortCode(shortId(item.id))).toEqual([]);
  });

  it('reports an ambiguous code rather than picking a winner', async () => {
    // Two ids sharing a first group. A prefix names a record only by prefix, so the caller has
    // to be able to tell "one match" from "more than one" and say so.
    const prefix = 'a1b2c3d4';
    // Ids are generated, so a collision has to be built by hand. Borrow a real location from a
    // normally-created item so the rows satisfy the schema's own constraints.
    const seed = await items.create({ name: 'Seed' });
    await driver.execute(
      `INSERT INTO items (id, name, location_id, quantity, is_active, created_at, updated_at)
       VALUES ('${prefix}-1111-4111-8111-111111111111', 'First', ?, 1, 1, 1, 1),
              ('${prefix}-2222-4222-8222-222222222222', 'Second', ?, 1, 1, 2, 2);`,
      [seed.locationId, seed.locationId],
    );
    const matches = await items.findByShortCode(prefix);
    expect(matches).toHaveLength(2);
  });

  it('refuses a value that is not a short code, so a LIKE wildcard can never scan the table', async () => {
    const item = await items.create({ name: 'Widget' });
    expect(await items.findByShortCode('%')).toEqual([]);
    expect(await items.findByShortCode('_______%')).toEqual([]);
    expect(await items.findByShortCode('')).toEqual([]);
    // A full uuid is not a short code either — `getById` is the lookup for that.
    expect(await items.findByShortCode(item.id)).toEqual([]);
  });
});
