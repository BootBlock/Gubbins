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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath, sourceFiles } from '@/test/repo-path';
import { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './queries';
import { invalidateItems } from './invalidate';
import { agendaKeys } from '@/features/calendar/keys';
import { projectKeys } from '@/features/projects/keys';
import { reportKeys } from '@/features/reports/keys';

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
    // omits it on purpose, is pinned in `invalidate.test.ts`. The agenda prefix joined for the
    // same reason the reports one did, and is owned by `calendar/agenda-invalidation.test.tsx`.
    // The custom-field due-date feed (W1a) is a sibling of `items()` too, so it likewise has to
    // be named — and it is asserted here exactly once, since sweeping the agenda prefix already
    // covers that lane's agenda twin.
    // The "Soon to Expire" feed is a sibling too, and had to be named once it started reading a
    // lot's expiry date as well as the item's own (issue #684).
    // The `projects` prefix joined for the same reason as the reports one: a project's shopping
    // list now reads stock, because a reservation only reduces what a line has to buy to the
    // extent stock backs it (issue #653).
    // The low-stock and warranty feeds are siblings too, and had to be named for a plainer
    // reason: nothing swept them at all, so both showed pre-write rows under counts that had
    // already refreshed (issue #606).
    expect(invalidated).toEqual([
      [...inventoryKeys.items()],
      [...inventoryKeys.itemAttention()],
      [...inventoryKeys.expiring()],
      [...inventoryKeys.lowStock()],
      [...inventoryKeys.warrantyExpiring()],
      [...reportKeys.all],
      [...agendaKeys.all],
      [...inventoryKeys.fieldDueDates()],
      [...projectKeys.all],
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

  it('is what every member of the factory is built from', () => {
    // The call-site check above only proves each hook reaches for *a* member. This is the other
    // half, and the one that actually holds the invalidation together: a member that forgot to
    // spread `reportKeys.all` would key its report outside the prefix `invalidateItems` sweeps,
    // and the report would quietly stop refreshing — the #375 regression, reintroduced one
    // report at a time. Asserted against the real arrays rather than the source text, so it
    // holds however a member is written.
    for (const [name, member] of Object.entries(reportKeys)) {
      if (name === 'all') continue;
      // Called with no arguments: the parameterised members leave `undefined` in the segments
      // that carry their inputs, which is irrelevant here — only the leading prefix is at stake.
      const key = (member as () => readonly unknown[])();
      expect(key.slice(0, reportKeys.all.length), name).toEqual([...reportKeys.all]);
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
