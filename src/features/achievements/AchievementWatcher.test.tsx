/**
 * Tests for {@link AchievementWatcher} — the root-level watcher that awards the item-count
 * achievements (issue #412). The item-count query is mocked so the transitions can be driven
 * deterministically; the burst and toast are exercised through the real providers. The contracts
 * that matter:
 *  - a threshold *crossed* while watching celebrates (toast + burst) and records the instant;
 *  - a threshold already satisfied when the count first settles is recorded silently, with no
 *    instant — the app has no idea when those items arrived, and says so;
 *  - a pending count is never mistaken for an empty inventory;
 *  - nothing is ever awarded twice, within a session or across one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const itemCountMock = vi.fn();
vi.mock('@/features/inventory/queries', () => ({ useItemCount: () => itemCountMock() }));

import { AchievementWatcher } from './AchievementWatcher';
import { BurstProvider, ToastProvider } from '@/components/foundry';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { MediaQueryProvider } from '@/components/foundry';

/** A reduced-motion provider reporting the given preference (full motion by default here). */
function motion(matches: boolean): MediaQueryProvider {
  return () => ({ matches, addEventListener() {}, removeEventListener() {} });
}

/**
 * A fresh element tree per call. It has to be fresh: React bails out of re-rendering when handed
 * the *same* element object twice, so a shared constant would make every `rerender` a no-op and
 * every transition below invisible.
 */
const tree = () => (
  <BurstProvider motionProvider={motion(false)}>
    <ToastProvider>
      <AchievementWatcher />
    </ToastProvider>
  </BurstProvider>
);

beforeEach(() => {
  useAchievementsStore.setState({ unlocked: {} });
  itemCountMock.mockReturnValue({ data: 0, isPending: false });
  // The burst is a flourish, off at the Balanced default; enable it (OS motion is injected).
  usePreferencesStore.setState({ animationLevel: 'headache' });
});
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'balanced' });
});

describe('AchievementWatcher', () => {
  it('celebrates the empty → first-item crossing with a toast and a burst', () => {
    const { rerender } = render(tree());
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    expect(useAchievementsStore.getState().unlocked).toEqual({});

    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(tree());

    expect(screen.getByText('Achievement unlocked: First item')).toBeInTheDocument();
    expect(screen.getByTestId('burst-overlay')).toBeInTheDocument();
    expect(typeof useAchievementsStore.getState().unlocked['first-item']).toBe('number');
  });

  it('celebrates every threshold a single jump crosses', () => {
    const { rerender } = render(tree());
    itemCountMock.mockReturnValue({ data: 100, isPending: false });
    rerender(tree());

    expect(screen.getByText('Achievement unlocked: First item')).toBeInTheDocument();
    expect(screen.getByText('Achievement unlocked: Ten items')).toBeInTheDocument();
    expect(screen.getByText('Achievement unlocked: A hundred items')).toBeInTheDocument();
    // Not reached, so not awarded.
    expect(useAchievementsStore.getState().unlocked['thousand-items']).toBeUndefined();
  });

  it('records an already-populated inventory silently, with no instant', () => {
    itemCountMock.mockReturnValue({ data: 5, isPending: false });
    render(tree());

    expect(screen.queryByText('Achievement unlocked: First item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    // Earned — the items are there — but the date is not known, so it is recorded as null.
    expect(useAchievementsStore.getState().unlocked['first-item']).toBeNull();
    expect(useAchievementsStore.getState().unlocked['ten-items']).toBeUndefined();
  });

  it('does not treat a pending count as an empty inventory', () => {
    itemCountMock.mockReturnValue({ data: undefined, isPending: true });
    const { rerender } = render(tree());

    itemCountMock.mockReturnValue({ data: 2, isPending: false });
    rerender(tree());

    expect(screen.queryByText('Achievement unlocked: First item')).not.toBeInTheDocument();
    expect(useAchievementsStore.getState().unlocked['first-item']).toBeNull();
  });

  it('does not treat a failed count as an empty inventory', () => {
    // An errored query is no longer pending and still has no data. Reading that as a settled zero
    // would make the next successful read look like a rising edge, and celebrate items that were
    // there all along.
    itemCountMock.mockReturnValue({ data: undefined, isPending: false });
    const { rerender } = render(tree());

    itemCountMock.mockReturnValue({ data: 40, isPending: false });
    rerender(tree());

    expect(screen.queryByText('Achievement unlocked: First item')).not.toBeInTheDocument();
    expect(screen.queryByText('Achievement unlocked: Ten items')).not.toBeInTheDocument();
    expect(useAchievementsStore.getState().unlocked['first-item']).toBeNull();
    expect(useAchievementsStore.getState().unlocked['ten-items']).toBeNull();
  });

  it('does not re-award after every item is deleted and one is added again', () => {
    const { rerender } = render(tree());
    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(tree());
    const awardedAt = useAchievementsStore.getState().unlocked['first-item'];

    itemCountMock.mockReturnValue({ data: 0, isPending: false });
    rerender(tree());
    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(tree());

    expect(useAchievementsStore.getState().unlocked['first-item']).toBe(awardedAt);
    expect(screen.getAllByText('Achievement unlocked: First item')).toHaveLength(1);
  });

  it('stays silent about an achievement already recorded on this device', () => {
    useAchievementsStore.setState({ unlocked: { 'first-item': 1_700_000_000_000 } });
    const { rerender } = render(tree());
    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(tree());

    expect(screen.queryByText('Achievement unlocked: First item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    expect(useAchievementsStore.getState().unlocked['first-item']).toBe(1_700_000_000_000);
  });
});
