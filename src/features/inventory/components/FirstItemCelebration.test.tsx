/**
 * Tests for {@link FirstItemCelebration} — the root-level watcher that fires the one-shot
 * first-item milestone burst (visual-flair F4) on the empty → first-item rising edge. The
 * item-count query is mocked so the transition can be driven deterministically; the burst and
 * toast are exercised through the real providers. The key contracts:
 *  - fires only after a genuinely-empty inventory becomes non-empty (never on a populated load);
 *  - fires at most once (guarded within a session and by the persistent store across sessions);
 *  - surfaces the milestone as an accessible toast, not just the decorative (aria-hidden) burst.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const itemCountMock = vi.fn();
vi.mock('@/features/inventory/queries', () => ({ useItemCount: () => itemCountMock() }));

import { FirstItemCelebration } from './FirstItemCelebration';
import { BurstProvider, ToastProvider } from '@/components/foundry';
import { useMilestonesStore } from '@/state/stores/useMilestonesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { MediaQueryProvider } from '@/components/foundry';

/** A reduced-motion provider reporting the given preference (full motion by default here). */
function motion(matches: boolean): MediaQueryProvider {
  return () => ({ matches, addEventListener() {}, removeEventListener() {} });
}

/** Render the watcher inside the real burst + toast providers, motion enabled. */
function renderWatcher() {
  return render(
    <BurstProvider motionProvider={motion(false)}>
      <ToastProvider>
        <FirstItemCelebration />
      </ToastProvider>
    </BurstProvider>,
  );
}

beforeEach(() => {
  useMilestonesStore.setState({ firstItemCelebrated: false });
  itemCountMock.mockReturnValue({ data: 0, isPending: false });
  // The burst is a flourish, off at the Balanced default; enable it (OS motion is injected).
  usePreferencesStore.setState({ animationLevel: 'headache' });
});
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'balanced' });
});

describe('FirstItemCelebration', () => {
  it('celebrates the empty → first-item transition once, with a toast + burst', () => {
    const { rerender } = renderWatcher();
    // Settled empty: nothing yet.
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    expect(screen.queryByText('Your first item!')).not.toBeInTheDocument();

    // First item appears → celebrate.
    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(
      <BurstProvider motionProvider={motion(false)}>
        <ToastProvider>
          <FirstItemCelebration />
        </ToastProvider>
      </BurstProvider>,
    );

    expect(screen.getByText('Your first item!')).toBeInTheDocument();
    expect(screen.getByTestId('burst-overlay')).toBeInTheDocument();
    expect(useMilestonesStore.getState().firstItemCelebrated).toBe(true);
  });

  it('does not fire for an already-populated inventory (never saw empty)', () => {
    itemCountMock.mockReturnValue({ data: 5, isPending: false });
    renderWatcher();
    expect(screen.queryByText('Your first item!')).not.toBeInTheDocument();
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    expect(useMilestonesStore.getState().firstItemCelebrated).toBe(false);
  });

  it('does not fire while the count is still pending', () => {
    itemCountMock.mockReturnValue({ data: undefined, isPending: true });
    const { rerender } = renderWatcher();
    // A pending count must not be treated as an empty inventory.
    itemCountMock.mockReturnValue({ data: 2, isPending: false });
    rerender(
      <BurstProvider motionProvider={motion(false)}>
        <ToastProvider>
          <FirstItemCelebration />
        </ToastProvider>
      </BurstProvider>,
    );
    expect(screen.queryByText('Your first item!')).not.toBeInTheDocument();
  });

  it('stays silent when the milestone was already celebrated on this device', () => {
    useMilestonesStore.setState({ firstItemCelebrated: true });
    const { rerender } = renderWatcher();
    itemCountMock.mockReturnValue({ data: 1, isPending: false });
    rerender(
      <BurstProvider motionProvider={motion(false)}>
        <ToastProvider>
          <FirstItemCelebration />
        </ToastProvider>
      </BurstProvider>,
    );
    expect(screen.queryByText('Your first item!')).not.toBeInTheDocument();
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
  });
});
