import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { and, leaf, or } from '@/test/ast';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Phase 5: the FTS5 full-text swap and the Weighted Capabilities surface
 * (spec §4, §5, §5.1). `node:sqlite` bundles FTS5, so the genuine virtual-table
 * path runs here; the real-browser smoke (§8.5.5) is the production FTS5 guard.
 */
describe('ItemRepository — FTS5 search (spec §5)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    await items.create({ name: 'LM7805 Regulator', description: '5V linear supply', mpn: 'LM7805' });
    await items.create({
      name: 'ESP32 DevKit',
      description: 'wifi microcontroller',
      manufacturer: 'Espressif',
    });
    await items.create({ name: 'Capacitor 10uF', description: 'electrolytic' });
  });

  afterEach(async () => {
    await driver.close();
  });

  async function searchNames(term: string): Promise<string[]> {
    const page = await items.list({ search: term });
    return page.rows.map((r) => r.name).sort();
  }

  it('matches by name prefix token via FTS5', async () => {
    expect(await searchNames('reg')).toEqual(['LM7805 Regulator']);
    expect(await searchNames('esp')).toEqual(['ESP32 DevKit']);
  });

  it('matches across description, mpn and manufacturer columns', async () => {
    expect(await searchNames('wifi')).toEqual(['ESP32 DevKit']);
    expect(await searchNames('lm7805')).toEqual(['LM7805 Regulator']);
    expect(await searchNames('espressif')).toEqual(['ESP32 DevKit']);
  });

  it('counts FTS matches consistently with list', async () => {
    expect(await items.count({ search: 'capacitor' })).toBe(1);
    expect(await items.count({ search: 'zzznomatch' })).toBe(0);
  });

  it('returns all items for a blank/whitespace search', async () => {
    const page = await items.list({ search: '   ' });
    expect(page.rows).toHaveLength(3);
  });
});

describe('ItemRepository — weighted capabilities (spec §4)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let itemId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    const item = await items.create({ name: 'LM7805 Regulator' });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('classifies a numeric value into value_num', async () => {
    const cap = await items.setCapability(itemId, { key: 'voltage', value: '5' });
    expect(cap.valueNum).toBe(5);
    expect(cap.valueText).toBeNull();
    expect(cap.weight).toBe(1.0);
  });

  it('classifies a non-numeric value into value_text', async () => {
    const cap = await items.setCapability(itemId, { key: 'package', value: 'TO-220', weight: 2 });
    expect(cap.valueNum).toBeNull();
    expect(cap.valueText).toBe('TO-220');
    expect(cap.weight).toBe(2);
  });

  it('overwrites a capability when the same key is set again (one per key)', async () => {
    await items.setCapability(itemId, { key: 'voltage', value: '5' });
    await items.setCapability(itemId, { key: 'Voltage', value: '12' });
    const caps = await items.listCapabilities(itemId);
    expect(caps).toHaveLength(1);
    expect(caps[0].valueNum).toBe(12);
  });

  it('lists capabilities ordered by key and removes by key', async () => {
    await items.setCapability(itemId, { key: 'voltage', value: '5' });
    await items.setCapability(itemId, { key: 'package', value: 'SMD' });
    expect((await items.listCapabilities(itemId)).map((c) => c.key)).toEqual(['package', 'voltage']);
    await items.removeCapability(itemId, 'PACKAGE');
    expect((await items.listCapabilities(itemId)).map((c) => c.key)).toEqual(['voltage']);
  });

  it('rejects a blank key and a negative weight', async () => {
    await expect(items.setCapability(itemId, { key: '  ', value: '5' })).rejects.toBeInstanceOf(DbError);
    await expect(
      items.setCapability(itemId, { key: 'voltage', value: '5', weight: -1 }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('refuses capability writes while storage is locked (Hard Stop)', async () => {
    const locked = new ItemRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.setCapability(itemId, { key: 'voltage', value: '5' })).rejects.toThrow(/suspended/);
  });

  it('lists the distinct capability vocabulary, busiest key first, with value kinds', async () => {
    const other = await items.create({ name: 'ESP32' });
    await items.setCapability(itemId, { key: 'voltage', value: '5' }); // numeric
    await items.setCapability(other.id, { key: 'voltage', value: '3.3' }); // numeric, same key
    await items.setCapability(itemId, { key: 'package', value: 'TO-220' }); // text only

    const page = await items.listCapabilityKeys();
    expect(page.rows.map((r) => r.key)).toEqual(['voltage', 'package']); // busiest first
    expect(page.rows[0]).toMatchObject({
      key: 'voltage',
      itemCount: 2,
      hasNumericValues: true,
      hasTextValues: false,
    });
    expect(page.rows[1]).toMatchObject({
      key: 'package',
      itemCount: 1,
      hasNumericValues: false,
      hasTextValues: true,
    });
  });

  it('excludes capabilities of soft-deleted items from the vocabulary', async () => {
    await items.setCapability(itemId, { key: 'voltage', value: '5' });
    await items.softDelete(itemId);
    expect((await items.listCapabilityKeys()).rows).toHaveLength(0);
  });
});

describe('ItemRepository.searchByAst (spec §5.1)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    const reg = await items.create({ name: 'LM7805 Regulator', manufacturer: 'TI', quantity: 50 });
    const mcu = await items.create({ name: 'ESP32', manufacturer: 'Espressif', quantity: 3 });
    await items.setCapability(reg.id, { key: 'voltage', value: '5' });
    await items.setCapability(mcu.id, { key: 'voltage', value: '3.3' });
  });

  afterEach(async () => {
    await driver.close();
  });

  it('paginates items matching a parsed AST', async () => {
    const page = await items.searchByAst(and(leaf('capability:voltage', 'GREATER_THAN', 4)));
    expect(page.rows.map((r) => r.name)).toEqual(['LM7805 Regulator']);
  });

  it('counts AST matches', async () => {
    expect(await items.countByAst(and(leaf('quantity', 'GREATER_THAN', 10)))).toBe(1);
    expect(await items.countByAst(and())).toBe(2);
  });

  it('excludes soft-deleted items by default', async () => {
    const all = await items.list({ limit: 100 });
    await items.softDelete(all.rows.find((r) => r.name === 'ESP32')!.id);
    expect(await items.countByAst(and())).toBe(1);
    expect(await items.countByAst(and(), { includeInactive: true })).toBe(2);
  });

  it('lets an explicit active filter decide, rather than AND-ing it away (issue #140)', async () => {
    const all = await items.list({ limit: 100 });
    await items.softDelete(all.rows.find((r) => r.name === 'ESP32')!.id);

    // Without this, `active:no` would meet the implicit `is_active = 1` and match nothing.
    const inactive = await items.searchByAst(and(leaf('active', 'EQUALS', false)));
    expect(inactive.rows.map((r) => r.name)).toEqual(['ESP32']);
    expect(await items.countByAst(and(leaf('active', 'EQUALS', false)))).toBe(1);

    // Asking for active items still gets only those, and the default scope is untouched.
    const active = await items.searchByAst(and(leaf('active', 'EQUALS', true)));
    expect(active.rows.map((r) => r.name)).toEqual(['LM7805 Regulator']);
    expect(await items.countByAst(and(leaf('quantity', 'GREATER_THAN', -1)))).toBe(1);
  });
});

/**
 * The Inventory sidebar's selected location scopes a Visual-Builder search exactly as it scopes
 * the plain list (issue #626) — before this, the sidebar kept "Garage" highlighted while the
 * results came from every room.
 */
describe('ItemRepository.searchByAst — location scope (issue #626)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let garageId: string;
  let shedId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    const locations = new LocationRepository(driver);
    items = new ItemRepository(driver);
    garageId = (await locations.create({ name: 'Garage' })).id;
    shedId = (await locations.create({ name: 'Shed' })).id;
    await items.create({ name: 'Socket Set', locationId: garageId, quantity: 2 });
    await items.create({ name: 'Spanner', locationId: garageId, quantity: 40 });
    await items.create({ name: 'Trowel', locationId: shedId, quantity: 1 });
  });

  afterEach(async () => {
    await driver.close();
  });

  it('restricts the results to the given location', async () => {
    const page = await items.searchByAst(and(leaf('quantity', 'LESS_THAN', 5)), { locationId: garageId });
    expect(page.rows.map((r) => r.name)).toEqual(['Socket Set']);
  });

  it('counts the same set the search returns, so the summary cannot disagree with the list', async () => {
    const ast = and(leaf('quantity', 'LESS_THAN', 5));
    expect(await items.countByAst(ast)).toBe(2); // Socket Set + Trowel, inventory-wide
    expect(await items.countByAst(ast, { locationId: garageId })).toBe(1);
  });

  it('searches the whole inventory when no location is given', async () => {
    const page = await items.searchByAst(and(leaf('quantity', 'LESS_THAN', 5)));
    expect(page.rows.map((r) => r.name).sort()).toEqual(['Socket Set', 'Trowel']);
  });

  it('lets a tree that names `location` itself decide, rather than AND-ing it away', async () => {
    // Without the lift, "in the Shed" AND-ed with the Garage scope is unsatisfiable.
    const ast = and(leaf('location', 'EQUALS', shedId));
    const page = await items.searchByAst(ast, { locationId: garageId });
    expect(page.rows.map((r) => r.name)).toEqual(['Trowel']);
    expect(await items.countByAst(ast, { locationId: garageId })).toBe(1);
  });

  it('applies the location scope alongside the implicit active-inventory one', async () => {
    const all = await items.list({ limit: 100 });
    await items.softDelete(all.rows.find((r) => r.name === 'Socket Set')!.id);
    expect(await items.countByAst(and(), { locationId: garageId })).toBe(1); // Spanner only
    expect(await items.countByAst(and(), { locationId: garageId, includeInactive: true })).toBe(2);
  });
});

describe('ItemRepository.searchByAst — weighted "best match" ranking (spec §4, §5.1)', () => {
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

  it('orders capability matches by summed weight, heaviest first', async () => {
    // "Alpha" sorts first alphabetically but carries a lighter voltage weight, so the
    // ranking must surface the heavier "Zeta" ahead of it — proving weight beats name.
    const alpha = await items.create({ name: 'Alpha widget' });
    const zeta = await items.create({ name: 'Zeta widget' });
    await items.setCapability(alpha.id, { key: 'voltage', value: '5', weight: 1 });
    await items.setCapability(zeta.id, { key: 'voltage', value: '5', weight: 9 });

    const page = await items.searchByAst(and(leaf('capability:voltage', 'HAS_CAPABILITY', '')));
    expect(page.rows.map((r) => r.name)).toEqual(['Zeta widget', 'Alpha widget']);
  });

  it('sums weights across several queried capabilities (more matches rank higher)', async () => {
    const both = await items.create({ name: 'Both caps' });
    const one = await items.create({ name: 'Aaa one cap' }); // sorts first alphabetically
    await items.setCapability(both.id, { key: 'voltage', value: '5', weight: 2 });
    await items.setCapability(both.id, { key: 'package', value: 'SMD', weight: 2 });
    await items.setCapability(one.id, { key: 'voltage', value: '5', weight: 3 });

    const page = await items.searchByAst(
      or(leaf('capability:voltage', 'HAS_CAPABILITY', ''), leaf('capability:package', 'HAS_CAPABILITY', '')),
    );
    // "Both caps" totals 4 > "Aaa one cap" totals 3, so it wins despite the later name.
    expect(page.rows.map((r) => r.name)).toEqual(['Both caps', 'Aaa one cap']);
  });

  it('falls back to alphabetical order when the query has no capability conditions', async () => {
    await items.create({ name: 'Zebra' });
    await items.create({ name: 'Antelope' });
    const page = await items.searchByAst(and(leaf('quantity', 'GREATER_THAN', -1)));
    expect(page.rows.map((r) => r.name)).toEqual(['Antelope', 'Zebra']);
  });

  // Issue #128 — the inventory's Sort control applies to Visual-search results too, so an
  // explicit sort has to beat the relevance ranking rather than be quietly ignored.
  it('lets an explicit sort replace the capability relevance ranking', async () => {
    const alpha = await items.create({ name: 'Alpha widget' });
    const zeta = await items.create({ name: 'Zeta widget' });
    // Zeta outranks Alpha on weight, so relevance alone would put it first.
    await items.setCapability(alpha.id, { key: 'voltage', value: '5', weight: 1 });
    await items.setCapability(zeta.id, { key: 'voltage', value: '5', weight: 9 });

    const ranked = await items.searchByAst(and(leaf('capability:voltage', 'HAS_CAPABILITY', '')));
    expect(ranked.rows.map((r) => r.name)).toEqual(['Zeta widget', 'Alpha widget']);

    const sorted = await items.searchByAst(and(leaf('capability:voltage', 'HAS_CAPABILITY', '')), {
      sort: [{ field: 'name', direction: 'asc' }],
    });
    expect(sorted.rows.map((r) => r.name)).toEqual(['Alpha widget', 'Zeta widget']);
  });
});
