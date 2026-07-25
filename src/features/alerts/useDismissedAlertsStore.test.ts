/**
 * Storage tests for `useDismissedAlertsStore` (issue #134).
 *
 * The store gained a shape — a dismissal is now a record with a deadline, not a bare id — so the
 * two boundaries that shape crosses are what matter here: the **migration** off the shipped array
 * of ids (getting this wrong silently un-dismisses everything the user had already dealt with),
 * and the **rehydration** of an untyped `JSON.parse` result (getting this wrong admits a phantom
 * record that hides an alert the user can no longer see to restore). The filtering and pruning
 * rules themselves are pure and covered in `alerts.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';

const KEY = 'gubbins:dismissed-alerts';
const state = () => useDismissedAlertsStore.getState();

/** Seed `localStorage` with a persisted payload and replay Zustand's rehydration. */
async function rehydrateFrom(persisted: unknown, version: number): Promise<void> {
  localStorage.setItem(KEY, JSON.stringify({ state: persisted, version }));
  await useDismissedAlertsStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  useDismissedAlertsStore.setState({ dismissals: new Map() });
});

describe('useDismissedAlertsStore — actions', () => {
  it('records a dismissal as indefinite and a snooze with its deadline', () => {
    state().dismiss('low-stock:a');
    state().snooze('low-stock:b', 1_700_000_000_000);

    expect(state().dismissals.get('low-stock:a')?.until).toBeNull();
    expect(state().dismissals.get('low-stock:b')?.until).toBe(1_700_000_000_000);
  });

  it('lets a later snooze replace an earlier dismissal of the same alert', () => {
    state().dismiss('low-stock:a');
    state().snooze('low-stock:a', 1_700_000_000_000);

    expect(state().dismissals.size).toBe(1);
    expect(state().dismissals.get('low-stock:a')?.until).toBe(1_700_000_000_000);
  });

  it('restores one alert and clears them all', () => {
    state().dismiss('low-stock:a');
    state().dismiss('low-stock:b');

    state().restore('low-stock:a');
    expect([...state().dismissals.keys()]).toEqual(['low-stock:b']);

    state().clearAll();
    expect(state().dismissals.size).toBe(0);
  });

  it('adopts a replacement map without aliasing the caller’s copy', () => {
    const pruned = new Map([['low-stock:a', { until: null, at: 1 }]]);
    state().replace(pruned);
    pruned.clear();

    expect(state().dismissals.size).toBe(1);
  });
});

describe('useDismissedAlertsStore — migration from the id-array shape', () => {
  it('keeps every previously dismissed id, as an indefinite dismissal', async () => {
    await rehydrateFrom({ dismissedIds: ['low-stock:a', 'expiry:b'] }, 1);

    expect([...state().dismissals.keys()]).toEqual(['low-stock:a', 'expiry:b']);
    expect(state().dismissals.get('low-stock:a')?.until).toBeNull();
  });

  it('stamps the migrated records with the upgrade time, not the epoch', async () => {
    // A record stamped 0 would be a month past its grace period the instant it was written, so
    // the first prune would discard the whole set the migration had just rescued.
    const before = Date.now();
    await rehydrateFrom({ dismissedIds: ['low-stock:a'] }, 0);

    expect(state().dismissals.get('low-stock:a')?.at).toBeGreaterThanOrEqual(before);
  });

  it('survives a persisted payload whose ids are not strings', async () => {
    await rehydrateFrom({ dismissedIds: ['low-stock:a', 42, null] }, 1);

    expect([...state().dismissals.keys()]).toEqual(['low-stock:a']);
  });

  it('starts empty when the old payload has no ids at all', async () => {
    await rehydrateFrom({}, 1);

    expect(state().dismissals.size).toBe(0);
  });
});

describe('useDismissedAlertsStore — rehydration', () => {
  it('round-trips what it persisted', async () => {
    state().dismiss('low-stock:a');
    state().snooze('expiry:b', 1_700_000_000_000);
    const persisted = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { state: unknown };

    useDismissedAlertsStore.setState({ dismissals: new Map() });
    await rehydrateFrom(persisted.state, 2);

    expect(state().dismissals.get('low-stock:a')?.until).toBeNull();
    expect(state().dismissals.get('expiry:b')?.until).toBe(1_700_000_000_000);
  });

  it.each([
    ['a missing deadline', { 'low-stock:a': { at: 1 } }],
    ['a non-numeric deadline', { 'low-stock:a': { until: 'soon', at: 1 } }],
    ['a missing timestamp', { 'low-stock:a': { until: null } }],
    ['a non-numeric timestamp', { 'low-stock:a': { until: null, at: 'yesterday' } }],
    ['a non-object record', { 'low-stock:a': 'dismissed' }],
  ])('drops a record with %s', async (_label, dismissals) => {
    await rehydrateFrom({ dismissals }, 2);

    expect(state().dismissals.size).toBe(0);
  });

  it('starts empty when the persisted value is not an object', async () => {
    await rehydrateFrom({ dismissals: ['low-stock:a'] }, 2);

    expect(state().dismissals.size).toBe(0);
  });
});
