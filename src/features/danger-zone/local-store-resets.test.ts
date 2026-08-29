/**
 * Guards the live-store reset behind a local-scope erase (issue #381).
 *
 * The bug this locks down was silent: erasing a local target removed the `localStorage` key but
 * left the Zustand store holding its state, so the erase didn't show until the next app start and
 * the store's next write put the whole erased blob back. The regression test below drives exactly
 * that sequence against a real persisted store.
 *
 * It also checks the record is *complete* against the shared key registry, so a newly-erasable key
 * cannot be added without deciding how (or whether) its live copy resets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/storage-keys';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';
import {
  LOCAL_STORE_RESETS,
  resetErasedLocalState,
  resetLocalStores,
  toDefaults,
} from './local-store-resets';

/** Every key an erase target actually removes, per the registry. */
const ERASABLE_LOCAL_KEYS = STORAGE_KEYS.filter(
  (entry) => entry.storage === 'local' && entry.eraseGroup !== null,
).map((entry) => entry.key);

describe('LOCAL_STORE_RESETS coverage', () => {
  it('declares a reset (or an explicit null) for every erasable key', () => {
    const missing = ERASABLE_LOCAL_KEYS.filter((key) => !(key in LOCAL_STORE_RESETS));
    expect(
      missing,
      'These keys are erasable but declare nothing here, so erasing them would leave the live ' +
        'store holding the old state (issue #381). Add a reset, or an explicit null with a ' +
        'comment saying why no live copy exists.',
    ).toEqual([]);
  });

  it('does not declare a reset for a key no erase target removes', () => {
    const erasable = new Set(ERASABLE_LOCAL_KEYS);
    const stray = Object.keys(LOCAL_STORE_RESETS).filter((key) => !erasable.has(key));
    expect(stray, 'Declared resets for keys nothing erases — remove them.').toEqual([]);
  });

  it('resets the great majority of erasable keys rather than opting out wholesale', () => {
    // A cheap smell test: `null` is for the genuinely stateless cases, so if most entries became
    // null someone has opted out of the fix rather than wiring a store.
    const wired = ERASABLE_LOCAL_KEYS.filter((key) => LOCAL_STORE_RESETS[key] !== null);
    expect(wired.length).toBeGreaterThan(ERASABLE_LOCAL_KEYS.length / 2);
  });
});

/** A persisted store shaped like the real ones, to drive the erase sequence end to end. */
function makeStore(key: string) {
  return create<{ items: string[]; add: (v: string) => void }>()(
    persist(
      (set) => ({
        items: [],
        add: (v) => set((s) => ({ items: [...s.items, v] })),
      }),
      { name: key, storage: createJSONStorage(() => localStorage) },
    ),
  );
}

const TEST_KEY = 'gubbins:test-store';

describe('resetLocalStores', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('regression: an erased store no longer re-persists its old state on the next write', () => {
    const store = makeStore(TEST_KEY);
    store.getState().add('saved-by-the-user');
    expect(localStorage.getItem(TEST_KEY)).toContain('saved-by-the-user');

    // What `eraseTargets` does: drop the key. On its own this is the bug — the store still holds
    // the value in memory.
    localStorage.removeItem(TEST_KEY);
    expect(store.getState().items).toEqual(['saved-by-the-user']);

    resetLocalStores([TEST_KEY], localStorage, { [TEST_KEY]: toDefaults(store) });

    expect(store.getState().items).toEqual([]);
    expect(localStorage.getItem(TEST_KEY)).toBeNull();

    // The next ordinary write must persist only the post-erase state.
    store.getState().add('added-after-erase');
    expect(localStorage.getItem(TEST_KEY)).not.toContain('saved-by-the-user');
    expect(localStorage.getItem(TEST_KEY)).toContain('added-after-erase');
  });

  it('leaves storage clean, so the affected-count badge reads zero after an erase', () => {
    const store = makeStore(TEST_KEY);
    store.getState().add('x');
    localStorage.removeItem(TEST_KEY);

    resetLocalStores([TEST_KEY], localStorage, { [TEST_KEY]: toDefaults(store) });

    // The reset itself re-persists via the middleware; that write must not survive.
    expect(localStorage.getItem(TEST_KEY)).toBeNull();
  });

  it('resets a real production store, not just a stand-in', () => {
    // Proves `getInitialState()` returns the defaults (not the rehydrated state) through the real
    // persist middleware, and that the store's actions survive the `replace: true` write.
    useAchievementsStore.getState().unlock('first-item', 1_700_000_000_000);
    expect(useAchievementsStore.getState().unlocked['first-item']).toBe(1_700_000_000_000);

    resetLocalStores(['gubbins:milestones'], localStorage);

    expect(useAchievementsStore.getState().unlocked).toEqual({});
    expect(typeof useAchievementsStore.getState().unlock).toBe('function');
    expect(localStorage.getItem('gubbins:milestones')).toBeNull();
  });

  it('ignores keys with no live copy, and keys it knows nothing about', () => {
    expect(() =>
      resetLocalStores(['gubbins:google-drive-token', 'gubbins:not-a-real-key'], localStorage),
    ).not.toThrow();
  });

  it('keeps going when one store refuses to reset', () => {
    const boom = vi.fn(() => {
      throw new Error('store is unhappy');
    });
    const after = vi.fn();

    resetLocalStores(['a', 'b'], localStorage, { a: boom, b: after });

    expect(boom).toHaveBeenCalled();
    expect(after, 'a throwing reset must not strand the keys after it').toHaveBeenCalled();
  });
});

describe('resetErasedLocalState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /**
   * Erasing "App preferences" and "Bridge access token" together (issue #521): the second target
   * clears a *field* of the same blob the first removes wholesale. Both resets write through the
   * persist middleware, so the field reset has to happen before the key removal that drops it —
   * the other way round, the erase reports success and leaves `gubbins:preferences` behind with a
   * full set of defaults, and the affected-count badge reads 1 again.
   */
  it('regression: a field reset cannot resurrect a key the same erase removed', () => {
    // The real key the `preferences` target owns, so the stand-in store stands in for the store
    // the ordering bug actually resurrected.
    const prefsKey = 'gubbins:preferences';
    const store = makeStore(prefsKey);
    store.getState().add('x');
    // What `eraseTargets` already did for the whole-key target.
    localStorage.removeItem(prefsKey);

    const order: string[] = [];
    resetErasedLocalState(
      ['preferences', 'bridge-token'],
      localStorage,
      {
        [prefsKey]: () => {
          order.push('key');
          toDefaults(store)();
        },
      },
      (fields) => {
        order.push('fields');
        // Stand in for `resetPreferenceFields`: a write through the same store's middleware.
        if (fields.length > 0) store.getState().add('reset-marker');
      },
    );

    expect(order).toEqual(['fields', 'key']);
    expect(localStorage.getItem(prefsKey)).toBeNull();
  });
});
