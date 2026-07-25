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
    // The two decide "low" separately — this counts with `lowStockPredicateSql` in SQL, `/metrics`
    // with the pure `isLow` seam — but from the same thresholds, and the app's own drift guard
    // (`stock-attention-parity.test.ts`) holds those two predicates to one answer. This asserts
    // the bridge wires them to the same thresholds, so a threshold that moved on one surface and
    // not the other shows up here. It is not a claim that the totals always match: `/metrics`
    // stops at `MAX_ITEMS_SCANNED` active items, whereas these counts are a whole-table aggregate.
    const statuses = await projectItemStatuses(hydrated.driver);
    const metrics = await projectMetrics(hydrated.driver);
    expect(statuses['low-stock']).toBe(metrics.lowStockItems);
    expect(statuses['out-of-stock']).toBe(metrics.outOfStockItems);
  });
});
