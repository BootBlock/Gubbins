import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DEFAULT_PAGE_SIZE } from './constants';
import { ItemRepository } from './ItemRepository';

/**
 * `ItemRepository.searchByRelevance` — the free-text read a fixed-size picker needs (issue #629).
 *
 * The scenario is the one that made the command palette wrong: far more items *mention* a word
 * than are *called* it. `list({ search })` filters correctly and then orders alphabetically, so
 * its first page is a slice of the match set chosen by first letter — and the one item actually
 * named after the query can sit past the end of it. A picker that ranks only what that page
 * contained can therefore never offer the right answer, however good its ranking is.
 */
describe('ItemRepository — relevance search (issue #629)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  /** More items than one page holds, every one of them mentioning screws in its description. */
  const MENTIONS = DEFAULT_PAGE_SIZE + 10;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    for (let i = 0; i < MENTIONS; i += 1) {
      await items.create({
        // Sorts alphabetically ahead of the item below, exactly as the real inventory's
        // "Anchor screw" / "Bracket, screw-fixed" rows do.
        name: `Anchor bracket ${String(i).padStart(3, '0')}`,
        description: 'mounts to a wall, fixed with screws',
      });
    }
    await items.create({ name: 'Screw, M4x20', description: 'stainless machine screw' });
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is the read the alphabetical list cannot be: the exactly-named item is off the first page', async () => {
    // Not a claim about `list` being broken — this is the ordering it is *meant* to have. It is
    // the reason a picker must not treat one page of it as the candidate pool.
    const page = await items.list({ search: 'screw' });
    expect(page.rows).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page.rows.map((r) => r.name)).not.toContain('Screw, M4x20');
  });

  it('ranks a name match ahead of the items that merely mention the word', async () => {
    const best = await items.searchByRelevance('screw', { limit: 8 });
    expect(best.rows[0]?.name).toBe('Screw, M4x20');
  });

  it('reports how many matched in total, not how many it returned', async () => {
    const best = await items.searchByRelevance('screw', { limit: 8 });
    expect(best.rows).toHaveLength(8);
    expect(best.total).toBe(MENTIONS + 1);
    // The total is the same set `count` measures, so a caller can say "8 of N" without the two
    // numbers describing different queries.
    expect(best.total).toBe(await items.count({ search: 'screw' }));
  });

  it('matches the indexed identifier columns, not just the name', async () => {
    await items.create({ name: 'Voltage regulator', mpn: 'LM7805', manufacturer: 'Texas Instruments' });
    expect((await items.searchByRelevance('lm7805')).rows.map((r) => r.name)).toEqual(['Voltage regulator']);
  });

  it('scopes to active inventory unless asked otherwise, as the list does', async () => {
    const removed = await items.create({ name: 'Screw, M3x10' });
    await items.softDelete(removed.id);
    expect((await items.searchByRelevance('m3x10')).total).toBe(0);
    expect((await items.searchByRelevance('m3x10', { includeInactive: true })).total).toBe(1);
  });

  it('matches nothing for text with no usable search tokens', async () => {
    expect(await items.searchByRelevance('   ')).toEqual({ rows: [], total: 0 });
  });
});
