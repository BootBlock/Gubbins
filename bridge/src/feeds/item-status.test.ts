/**
 * Attention-status projection tests (issue #146) over the SYNTHETIC feeds fixture — the same one
 * the `/metrics` exposition uses, so the two surfaces are asserted against identical data and a
 * drift between them would show up here.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { projectItemStatuses } from './item-status.ts';
import { projectMetrics } from './metrics.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-feeds-snapshot.json', import.meta.url);

let hydrated: HydrateResult;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});

afterAll(async () => {
  await hydrated.driver.close();
});

describe('projectItemStatuses', () => {
  it('counts every attention status, zero-filling the ones nothing matches', async () => {
    // The fixture holds two items below their reorder point (one of them fully depleted), a
    // well-stocked one, and a soft-deleted one that must not count towards anything.
    expect(await projectItemStatuses(hydrated.driver)).toEqual({
      'low-stock': 2,
      'out-of-stock': 1,
      'on-order': 0,
      expiring: 0,
      warranty: 0,
      'on-loan': 0,
      overdue: 0,
      'maintenance-due': 0,
    });
  });

  it('reports the same low/out-of-stock figures the /metrics exposition publishes', async () => {
    // Both now count through the same `applicableStatuses` seam over the whole table, with the
    // same thresholds — so this is a true equality, not the "same idea of low, possibly different
    // totals" it was while `/metrics` walked a capped page of items (issue #532). A threshold or a
    // candidate set that moved on one surface and not the other still shows up here.
    const statuses = await projectItemStatuses(hydrated.driver);
    const metrics = await projectMetrics(hydrated.driver);
    expect(statuses['low-stock']).toBe(metrics.lowStockItems);
    expect(statuses['out-of-stock']).toBe(metrics.outOfStockItems);
  });
});
