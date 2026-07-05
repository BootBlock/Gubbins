/**
 * DashboardBanner — the pre-1.0 "work in progress" warning and its confirm-to-dismiss flow.
 *
 * The banner shows by default (pre-1.0); its close button must not dismiss silently — it
 * opens a confirmation that makes the user acknowledge the data-loss risk, and only a
 * positive confirm persists the dismissal (`wipBannerDismissed`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DashboardBanner } from './DashboardBanner';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** Click through the Foundry Modal (portalled to document.body) with a full act flush. */
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

beforeEach(() => {
  usePreferencesStore.setState({ wipBannerDismissed: false });
});
afterEach(cleanup);

describe('DashboardBanner', () => {
  it('shows the work-in-progress warning by default', () => {
    render(<DashboardBanner />);
    expect(screen.getByTestId('dashboard-wip-banner')).toBeTruthy();
  });

  it('hides when previously dismissed', () => {
    usePreferencesStore.setState({ wipBannerDismissed: true });
    render(<DashboardBanner />);
    expect(screen.queryByTestId('dashboard-wip-banner')).toBeNull();
  });

  it('does not dismiss immediately — the close button opens a confirmation first', async () => {
    render(<DashboardBanner />);
    await click(screen.getByTestId('wip-banner-dismiss'));
    // Still visible, and the confirmation (with the data-loss warning) is now shown.
    expect(screen.getByTestId('dashboard-wip-banner')).toBeTruthy();
    expect(screen.getByText(/you can lose your data/i)).toBeTruthy();
    expect(usePreferencesStore.getState().wipBannerDismissed).toBe(false);
  });

  it('dismisses and persists the choice once the warning is confirmed', async () => {
    render(<DashboardBanner />);
    await click(screen.getByTestId('wip-banner-dismiss'));
    await click(screen.getByTestId('wip-banner-confirm-dismiss'));
    expect(usePreferencesStore.getState().wipBannerDismissed).toBe(true);
    expect(screen.queryByTestId('dashboard-wip-banner')).toBeNull();
  });

  it('keeps the banner when the confirmation is cancelled', async () => {
    render(<DashboardBanner />);
    await click(screen.getByTestId('wip-banner-dismiss'));
    await click(screen.getByRole('button', { name: /keep the warning/i }));
    expect(usePreferencesStore.getState().wipBannerDismissed).toBe(false);
    expect(screen.getByTestId('dashboard-wip-banner')).toBeTruthy();
  });
});
