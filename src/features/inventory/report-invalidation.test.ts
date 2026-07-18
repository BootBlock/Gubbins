/**
 * The item ⇄ reports invalidation invariant (issue #375).
 *
 * Every §3 report aggregates the same item and ledger rows the `['inventory','items']` prefix
 * covers, so a write that reshapes one reshapes the other. Historically the two drifted badly —
 * `items()` was invalidated from forty sites and `['reports']` from four — which left a quantity
 * or gauge adjustment showing pre-adjustment figures on the Reports screen.
 *
 * `invalidateItems` is the single seam that keeps them together. These tests pin both halves:
 * that the helper really invalidates both prefixes, and that no call site has quietly gone back
 * to invalidating `items()` on its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './queries';
import { invalidateItems } from './invalidate';
import { reportKeys } from '@/features/reports/keys';

/** Recursively collect every source file under `src/`, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const SRC = join(process.cwd(), 'src');

describe('invalidateItems', () => {
  it('invalidates the item prefix and the reports prefix together', async () => {
    const client = new QueryClient();
    const invalidated: unknown[][] = [];
    client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
      invalidated.push(filters?.queryKey ?? []);
      return Promise.resolve();
    }) as QueryClient['invalidateQueries'];

    invalidateItems(client);

    expect(invalidated).toEqual([[...inventoryKeys.items()], [...reportKeys.all]]);
  });
});

describe('the reports prefix', () => {
  it('is the prefix every report query key is built from', () => {
    const queries = readFileSync(join(SRC, 'features', 'reports', 'queries.ts'), 'utf8');
    const keys = [...queries.matchAll(/queryKey: (.+),$/gm)].map((m) => m[1]);

    // Every `useQuery` must have contributed a key, or one has taken a shape the sweep
    // below can't see — which would let it drift off the prefix unnoticed.
    expect(keys).toHaveLength(queries.split('useQuery({').length - 1);
    for (const key of keys) {
      // Either the bare prefix or a key spread from it — never a re-typed `['reports', …]`,
      // which could drift out from under the invalidation.
      expect(key === 'reportKeys.all' || key?.startsWith('[...reportKeys.all,')).toBe(true);
    }
  });
});

describe('item invalidation call sites', () => {
  it('all route through invalidateItems rather than the raw prefix', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('features', 'inventory', 'invalidate.ts')))
      .filter((path) => readFileSync(path, 'utf8').includes('queryKey: inventoryKeys.items()'));

    expect(offenders).toEqual([]);
  });
});
