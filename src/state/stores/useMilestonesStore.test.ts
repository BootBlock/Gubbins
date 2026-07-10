import { beforeEach, describe, expect, it } from 'vitest';
import { useMilestonesStore } from './useMilestonesStore';

/** Read the store's current snapshot outside React. */
const state = () => useMilestonesStore.getState();

beforeEach(() => {
  // Reset to the pristine default so persisted state can't leak between cases.
  useMilestonesStore.setState({ firstItemCelebrated: false });
});

describe('useMilestonesStore', () => {
  it('starts with the first-item milestone uncelebrated', () => {
    expect(state().firstItemCelebrated).toBe(false);
  });

  it('celebrateFirstItem marks it celebrated', () => {
    state().celebrateFirstItem();
    expect(state().firstItemCelebrated).toBe(true);
  });

  it('is idempotent — celebrating again stays celebrated', () => {
    state().celebrateFirstItem();
    state().celebrateFirstItem();
    expect(state().firstItemCelebrated).toBe(true);
  });
});
