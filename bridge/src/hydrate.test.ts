/**
 * Phase HA-1 hydration tests over a SYNTHETIC fixture snapshot (made-up parts,
 * no real or personal data). Proves the snapshot round-trips into a queryable
 * Gubbins database and that the app's real search path answers correctly.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { parseTextQuery } from '@/features/search/parse-text-query';
import { TARGET_SCHEMA_VERSION } from '@/db/migrations';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

async function loadFixtureText(): Promise<string> {
  return readFile(fileURLToPath(FIXTURE_URL), 'utf8');
}

describe('hydrateFromJson (HA-1)', () => {
  let hydrated: HydrateResult;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    hydrated = await hydrateFromJson(await loadFixtureText());
    items = new ItemRepository(hydrated.driver);
    locations = new LocationRepository(hydrated.driver);
  });

  afterEach(async () => {
    await hydrated.driver.close();
  });

  it('migrates to the current target schema version', () => {
    expect(hydrated.migration.to).toBe(TARGET_SCHEMA_VERSION);
  });

  it('loads the expected row counts for each synced table', async () => {
    const count = async (sql: string) =>
      Number((await hydrated.driver.queryOne<{ n: number }>(sql))?.n ?? -1);

    // Active inventory items.
    expect(await count('SELECT COUNT(*) AS n FROM items WHERE is_active = 1')).toBe(4);
    // Non-system locations (the 2 system-locked ones are seeded by migrations).
    expect(await count('SELECT COUNT(*) AS n FROM locations WHERE is_system = 0')).toBe(3);
    expect(await count('SELECT COUNT(*) AS n FROM item_stock')).toBe(5);
    expect(await count('SELECT COUNT(*) AS n FROM capabilities')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM categories')).toBe(2);
  });

  it('keeps items.quantity = SUM(item_stock) via the recompute triggers', async () => {
    const esp32 = await items.getById('item-esp32');
    expect(esp32?.quantity).toBe(7); // 5 on Shelf 2 + 2 in Bin 4
  });

  it('round-trips a casual name query through parseTextQuery → searchByAst', async () => {
    const parsed = parseTextQuery('ESP32');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const page = await items.searchByAst(parsed.ast);
    expect(page.rows.map((r) => r.id)).toEqual(['item-esp32']);
    expect(page.rows[0]?.locationId).toBe('loc-shelf-2');
  });

  it('matches a distinctive token via the FTS index', async () => {
    const parsed = parseTextQuery('Nylon');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const page = await items.searchByAst(parsed.ast);
    expect(page.rows.map((r) => r.name)).toEqual(['M3 Nylon Washer']);
  });

  it('passes a power-user capability query through unchanged', async () => {
    const parsed = parseTextQuery('cap:voltage>3');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const page = await items.searchByAst(parsed.ast);
    expect(page.rows.map((r) => r.id)).toEqual(['item-esp32']);
  });

  it('exposes the per-location breakdown for a multi-location item', async () => {
    const placements = await items.listStock('item-esp32');
    const byLocation = new Map(placements.map((p) => [p.locationName, p.quantity]));
    expect(byLocation.get('Shelf 2')).toBe(5);
    expect(byLocation.get('Bin 4')).toBe(2);
  });

  it('resolves an item primary location name via the LocationRepository', async () => {
    const bolt = await items.getById('item-m3-bolt');
    const location = await locations.getById(bolt!.locationId);
    expect(location?.name).toBe('Drawer A');
  });
});

describe('parseBackupJson version guard (via hydrateFromJson)', () => {
  it('refuses a snapshot from a newer PWA build', async () => {
    const future = JSON.stringify({ formatVersion: 999, tables: {} });
    await expect(hydrateFromJson(future)).rejects.toThrow(/newer version/i);
  });

  it('rejects a non-JSON file with a clear message', async () => {
    await expect(hydrateFromJson('not json at all')).rejects.toThrow(/not valid JSON/i);
  });
});
