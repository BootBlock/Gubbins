/**
 * Inventory-state projection tests (EI-5) over a hydrated SYNTHETIC snapshot (no real data).
 *
 * The fixture is designed so every count is unambiguous: two active low-stock items (one of them
 * fully depleted) in the Store Room, one well-stocked item on the Workbench, and one soft-deleted
 * item that must NOT be counted. So: itemsTotal=3, lowStock=2, outOfStock=1, two locations.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { projectInventoryState } from './state.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-mqtt-snapshot.json', import.meta.url);
const GENERATED_AT = '2025-06-27T07:33:20.000Z';

let hydrated: HydrateResult;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});
afterAll(async () => {
  await hydrated.driver.close();
});

describe('projectInventoryState', () => {
  it('counts active items, low stock and out of stock (soft-deleted excluded)', async () => {
    const state = await projectInventoryState(hydrated.driver, { generatedAt: GENERATED_AT });
    expect(state.itemsTotal).toBe(3);
    expect(state.lowStockItems).toBe(2); // solder (3) + flux (0)
    expect(state.outOfStockItems).toBe(1); // flux (0)
    expect(state.generatedAt).toBe(GENERATED_AT);
  });

  it('projects each location with its live item count', async () => {
    const state = await projectInventoryState(hydrated.driver, { generatedAt: GENERATED_AT });
    const byId = new Map(state.locations.map((l) => [l.id, l]));
    expect(state.locations).toHaveLength(2);
    expect(byId.get('loc-store')).toEqual({ id: 'loc-store', name: 'Store Room', itemCount: 2 });
    // The Workbench holds one active item; the soft-deleted one is not counted.
    expect(byId.get('loc-bench')).toEqual({ id: 'loc-bench', name: 'Workbench', itemCount: 1 });
  });
});
