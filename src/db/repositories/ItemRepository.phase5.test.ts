import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { and, leaf, or } from '@/test/ast';
import { ItemRepository } from './ItemRepository';

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
    await expect(items.setCapability(itemId, { key: '  ', value: '5' })).rejects.toBeInstanceOf(
      DbError,
    );
    await expect(
      items.setCapability(itemId, { key: 'voltage', value: '5', weight: -1 }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('refuses capability writes while storage is locked (Hard Stop)', async () => {
    const locked = new ItemRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.setCapability(itemId, { key: 'voltage', value: '5' })).rejects.toThrow(
      /suspended/,
    );
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
    const page = await items.searchByAst(
      and(leaf('capability:voltage', 'GREATER_THAN', 4)),
    );
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
      or(
        leaf('capability:voltage', 'HAS_CAPABILITY', ''),
        leaf('capability:package', 'HAS_CAPABILITY', ''),
      ),
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
});
