import { describe, it, expect, beforeEach } from 'vitest';
import { useLocationExpansionStore } from './useLocationExpansionStore';

const store = () => useLocationExpansionStore.getState();

beforeEach(() => store().reset());

describe('useLocationExpansionStore', () => {
  it('records explicit expand / collapse overrides', () => {
    store().setExpanded('a', true);
    store().setExpanded('b', false);
    expect(store().overrides).toEqual({ a: true, b: false });
  });

  it('reset clears every override', () => {
    store().setExpanded('a', true);
    store().reset();
    expect(store().overrides).toEqual({});
  });

  it('prune drops overrides whose id is absent from the valid set', () => {
    store().setExpanded('keep', true);
    store().setExpanded('gone', true);
    store().prune(new Set(['keep']));
    expect(store().overrides).toEqual({ keep: true });
  });

  it('prune is a no-op (same reference) when nothing is stale', () => {
    store().setExpanded('a', true);
    store().setExpanded('b', false);
    const before = store().overrides;
    store().prune(new Set(['a', 'b']));
    // No stale entry ⇒ the same object reference, so subscribers are not needlessly notified.
    expect(store().overrides).toBe(before);
  });
});
