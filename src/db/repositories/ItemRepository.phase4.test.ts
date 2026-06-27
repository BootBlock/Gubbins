import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';

describe('ItemRepository — Phase 4 (MPN, costing & alias auto-match)', () => {
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

  it('persists mpn, manufacturer and unit cost on create', async () => {
    const item = await items.create({
      name: 'NE555 Timer',
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      unitCost: 0.42,
    });
    expect(item.mpn).toBe('NE555P');
    expect(item.manufacturer).toBe('Texas Instruments');
    expect(item.unitCost).toBe(0.42);
  });

  it('trims blank match keys to null and rejects a negative unit cost', async () => {
    const item = await items.create({ name: 'Generic', mpn: '   ', manufacturer: '' });
    expect(item.mpn).toBeNull();
    expect(item.manufacturer).toBeNull();
    await expect(items.create({ name: 'Bad', unitCost: -1 })).rejects.toBeInstanceOf(DbError);
  });

  it('updates the Phase 4 fields and can clear them', async () => {
    const item = await items.create({ name: 'Cap', mpn: 'OLD', unitCost: 1 });
    const updated = await items.update(item.id, { mpn: 'GRM188', unitCost: 0.01 });
    expect(updated.mpn).toBe('GRM188');
    expect(updated.unitCost).toBe(0.01);
    const cleared = await items.update(item.id, { mpn: null, unitCost: null });
    expect(cleared.mpn).toBeNull();
    expect(cleared.unitCost).toBeNull();
  });

  it('de-duplicates and trims an alias set', async () => {
    const item = await items.create({ name: 'Timer' });
    const aliases = await items.setAliases(item.id, ['NE555', 'ne555', '  LM555  ', '']);
    expect(aliases.map((a) => a.alias).sort()).toEqual(['LM555', 'NE555']);
  });

  it('matches by MPN case-insensitively, then by alias', async () => {
    const a = await items.create({ name: 'Timer', mpn: 'NE555P' });
    const b = await items.create({ name: 'Regulator' });
    await items.setAliases(b.id, ['LM7805', 'L7805']);

    expect((await items.findByMatchKey('ne555p'))?.id).toBe(a.id);
    expect((await items.findByMatchKey('L7805'))?.id).toBe(b.id);
    expect(await items.findByMatchKey('NOPE')).toBeUndefined();
    expect(await items.findByMatchKey('   ')).toBeUndefined();
  });

  it('rejects reusing an alias already owned by another item', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    await items.setAliases(a.id, ['SHARED']);
    await expect(items.setAliases(b.id, ['shared'])).rejects.toBeInstanceOf(DbError);
  });
});
