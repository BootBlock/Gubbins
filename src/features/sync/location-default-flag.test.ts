/**
 * Issue #191: `locations.is_default` marks the single place "Add item" pre-selects, maintained by
 * an app-level demote-then-set. Per-row LWW cannot see that demotion across a merge, so two devices
 * that each nominate a *different* default converge to two flagged rows. These are the pure helpers
 * every sync write path uses to reduce such a set to one deterministic winner.
 */
import { describe, it, expect } from 'vitest';
import type { SqlRow } from '@/db/rpc/driver';
import { dedupeDefaultLocations, defaultLocationWinner } from './location-default-flag';

/** A location row with the flag defaulted off; override what a case needs. */
function loc(over: Partial<SqlRow> & { id: string; updated_at: number }): SqlRow {
  return { name: over.id, is_default: 0, ...over };
}

describe('defaultLocationWinner', () => {
  it('returns null when no row carries the flag', () => {
    expect(
      defaultLocationWinner([loc({ id: 'l1', updated_at: 1 }), loc({ id: 'l2', updated_at: 2 })]),
    ).toBeNull();
  });

  it('returns the sole flagged row', () => {
    expect(
      defaultLocationWinner([
        loc({ id: 'l1', is_default: 1, updated_at: 1 }),
        loc({ id: 'l2', updated_at: 2 }),
      ]),
    ).toBe('l1');
  });

  it('returns the newest among several flagged rows', () => {
    expect(
      defaultLocationWinner([
        loc({ id: 'l1', is_default: 1, updated_at: 100 }),
        loc({ id: 'l2', is_default: 1, updated_at: 300 }),
        loc({ id: 'l3', is_default: 1, updated_at: 200 }),
      ]),
    ).toBe('l2');
  });

  it('breaks a tie among flagged rows by the smaller id', () => {
    expect(
      defaultLocationWinner([
        loc({ id: 'l-b', is_default: 1, updated_at: 100 }),
        loc({ id: 'l-a', is_default: 1, updated_at: 100 }),
      ]),
    ).toBe('l-a');
  });
});

describe('dedupeDefaultLocations', () => {
  it('keeps the winner and zeroes every other default', () => {
    const out = dedupeDefaultLocations([
      loc({ id: 'l1', is_default: 1, updated_at: 100 }),
      loc({ id: 'l2', is_default: 1, updated_at: 300 }),
      loc({ id: 'l3', updated_at: 50 }),
    ]);
    const byId = new Map(out.map((r) => [r.id, r]));
    expect(byId.get('l1')!.is_default).toBe(0);
    expect(byId.get('l2')!.is_default).toBe(1); // newest wins
    expect(byId.get('l3')!.is_default).toBe(0); // untouched non-default
  });

  it('is a pure copy — the input rows are never mutated', () => {
    const input = [
      loc({ id: 'l1', is_default: 1, updated_at: 100 }),
      loc({ id: 'l2', is_default: 1, updated_at: 300 }),
    ];
    dedupeDefaultLocations(input);
    expect(input[0]!.is_default).toBe(1);
    expect(input[1]!.is_default).toBe(1);
  });

  it('passes a set with no default through untouched', () => {
    const out = dedupeDefaultLocations([loc({ id: 'l1', updated_at: 1 }), loc({ id: 'l2', updated_at: 2 })]);
    expect(out.every((r) => r.is_default === 0)).toBe(true);
  });
});
