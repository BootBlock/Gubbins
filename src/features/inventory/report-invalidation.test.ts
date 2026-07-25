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
import { repoPath } from '@/test/repo-path';
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

// Resolved from this file's own location, not the cwd: a cwd-relative guard run from another
// checkout would sweep *its* sources and pass without ever seeing the change under test.
const SRC = repoPath(import.meta.dirname, 'src');

describe('invalidateItems', () => {
  it('invalidates the item prefix and the reports prefix together', async () => {
    const client = new QueryClient();
    const invalidated: unknown[][] = [];
    client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
      invalidated.push(filters?.queryKey ?? []);
      return Promise.resolve();
    }) as QueryClient['invalidateQueries'];

    invalidateItems(client);

    // `item-attention` joined the sweep with the #166 status-count split. It is a sibling of
    // `items()` rather than a child, so the broad helper has to name it explicitly — which is
    // exactly the drift risk this test exists to catch. The narrow `invalidateItemStock`, which
    // omits it on purpose, is pinned in `invalidate.test.ts`.
    expect(invalidated).toEqual([
      [...inventoryKeys.items()],
      [...inventoryKeys.itemAttention()],
      [...reportKeys.all],
    ]);
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
      // A member of the factory — never a re-typed `['reports', …]` or a key spread together at
      // the call site, either of which could drift out from under the invalidation (issue #379).
      expect(key?.startsWith('reportKeys.'), key).toBe(true);
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

  it('never invalidate the item-attention prefix outside the seam either (#166)', () => {
    // The split only pays off while `item-attention` is swept solely by the two helpers. A
    // call site reaching for the raw prefix would either re-broaden a stock write or, worse,
    // sweep it *without* `items()` and leave the halves disagreeing.
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('features', 'inventory', 'invalidate.ts')))
      .filter((path) => readFileSync(path, 'utf8').includes('queryKey: inventoryKeys.itemAttention()'));

    expect(offenders).toEqual([]);
  });
});
