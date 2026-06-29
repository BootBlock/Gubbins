/**
 * Phase HA-2 query-core tests over the SYNTHETIC fixture (made-up parts, no real or
 * personal data). Drives the real hydrated DB through `searchItems`/`whereIs` and
 * asserts the read-only DTOs, the per-location breakdown, the bounded result size, and
 * that the power-user grammar flows through unchanged. The pure spoken-answer shaper is
 * tested separately in `spoken.test.ts`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { searchItems, whereIs } from './query.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

describe('searchItems (HA-2)', () => {
  let hydrated: HydrateResult;

  beforeEach(async () => {
    hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  });

  afterEach(async () => {
    await hydrated.driver.close();
  });

  it('returns a compact DTO for an exact hit', async () => {
    const matches = await searchItems(hydrated.driver, 'ESP32 Dev Board');
    expect(matches).toEqual([
      {
        id: 'item-esp32',
        name: 'ESP32 Dev Board',
        quantity: 7,
        locationName: 'Shelf 2',
        mpn: 'DEV-ESP32',
        manufacturer: 'Synthetic Silicon Co',
      },
    ]);
  });

  it('returns nothing for a query that matches no item', async () => {
    expect(await searchItems(hydrated.driver, 'Nonexistent Widget')).toEqual([]);
  });

  it('returns an empty list for a blank query (never the whole inventory)', async () => {
    expect(await searchItems(hydrated.driver, '   ')).toEqual([]);
  });

  it('finds multiple hits for a shared name token', async () => {
    const matches = await searchItems(hydrated.driver, 'M3');
    expect(matches.map((m) => m.id).sort()).toEqual(['item-m3-bolt', 'item-m3-washer']);
  });

  it('bounds the result size to the requested limit', async () => {
    const matches = await searchItems(hydrated.driver, 'M3', { limit: 1 });
    expect(matches).toHaveLength(1);
  });

  it('passes a power-user capability query through unchanged (no name fallback)', async () => {
    // If this fell back to a name search, "cap:voltage>3" would match nothing; it returns
    // the ESP32, proving the AST grammar path ran end-to-end.
    const matches = await searchItems(hydrated.driver, 'cap:voltage>3');
    expect(matches.map((m) => m.id)).toEqual(['item-esp32']);
  });
});

describe('whereIs (HA-2)', () => {
  let hydrated: HydrateResult;

  beforeEach(async () => {
    hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  });

  afterEach(async () => {
    await hydrated.driver.close();
  });

  it('attaches the per-location breakdown for a multi-location item', async () => {
    const result = await whereIs(hydrated.driver, 'ESP32');
    expect(result.matches).toHaveLength(1);
    const byLocation = new Map(
      result.matches[0]!.placements.map((p) => [p.locationName, p.quantity]),
    );
    expect(byLocation.get('Shelf 2')).toBe(5);
    expect(byLocation.get('Bin 4')).toBe(2);
  });

  it('speaks a single-item, multi-location sentence', async () => {
    const result = await whereIs(hydrated.driver, 'ESP32');
    expect(result.spoken).toBe(
      'Your ESP32 Dev Board is spread across 2 locations: 5 on Shelf 2 and 2 in Bin 4 — 7 in total.',
    );
  });

  it('speaks a single-item, single-location sentence', async () => {
    const result = await whereIs(hydrated.driver, 'Nylon');
    expect(result.spoken).toBe('Your M3 Nylon Washer is in Drawer A — 100 in stock.');
  });

  it('speaks a not-found sentence', async () => {
    const result = await whereIs(hydrated.driver, 'Nonexistent Widget');
    expect(result.matches).toEqual([]);
    expect(result.spoken).toBe('I couldn\'t find anything matching "Nonexistent Widget".');
  });
});
