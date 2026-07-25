/**
 * Component tests for AlertsScreen — snoozing and dismissing an alert (issue #134).
 *
 * The alert *sources* are stubbed, but the dismissal store and the pure `applyDismissals` seam
 * are the real ones: the point of these tests is the round trip from the card's controls through
 * the store and back out of the feed, which a fully-mocked hook could not show. Snoozing must
 * hide the card *and* record a deadline that lets it return; dismissing must hide it with no
 * deadline at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Alert } from './alerts';

/** One low-stock alert — enough to exercise a card's controls. */
const ALERT: Alert = {
  id: 'low-stock:widget-1',
  kind: 'low-stock',
  severity: 'warning',
  title: 'Low stock — Brass widget',
  detail: 'This item is at or below its reorder point.',
  dueAt: null,
  target: { route: '/inventory', itemId: 'widget-1', itemName: 'Brass widget' },
};

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers it.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

// The feed is stubbed, but its dismissal filtering is not: the mock runs the real seam against
// the real store, so what the screen shows reflects what the card's controls actually recorded.
vi.mock('./useAlerts', () => ({
  useAlerts: () => {
    const dismissals = useDismissedAlertsStore((s) => s.dismissals);
    return {
      alerts: applyDismissals([ALERT], dismissals, Date.now()),
      allAlerts: [ALERT],
      isLoading: false,
      isError: false,
    };
  },
}));

// Stub the router Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// The global nav menu has its own suite; stub it so this test needs no router context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// Imported after the mocks are registered.
import { AlertsScreen } from './AlertsScreen';
import { applyDismissals } from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const dismissals = () => useDismissedAlertsStore.getState().dismissals;

beforeEach(() => {
  localStorage.clear();
  useDismissedAlertsStore.setState({ dismissals: new Map() });
});

afterEach(cleanup);

/** Open the card's snooze menu and choose the row with the given label. */
function snooze(label: string): void {
  fireEvent.click(screen.getByTestId(`snooze-alert-${ALERT.id}`));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

describe('AlertsScreen — snoozing an alert', () => {
  it('offers a snooze menu named after the alert it belongs to', () => {
    render(<AlertsScreen />);

    const trigger = screen.getByTestId(`snooze-alert-${ALERT.id}`);
    expect(trigger.getAttribute('aria-label')).toBe(`Snooze alert: ${ALERT.title}`);

    fireEvent.click(trigger);
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Snooze for a day',
      'Snooze for a week',
      'Snooze for a month',
    ]);
  });

  it('hides the alert and records a deadline it can come back from', () => {
    render(<AlertsScreen />);
    const before = Date.now();

    snooze('Snooze for a week');

    expect(screen.queryByTestId(`alert-card-${ALERT.id}`)).toBeNull();
    const until = dismissals().get(ALERT.id)?.until;
    // A week away, give or take the render — and crucially not `null`, which never returns.
    expect(until).toBeGreaterThan(before + 6 * DAY_MS);
    expect(until).toBeLessThan(before + 8 * DAY_MS);
  });

  it('announces the snooze, which otherwise removes a card in silence', () => {
    render(<AlertsScreen />);

    snooze('Snooze for a day');

    expect(screen.getByTestId('alerts-action-live-region').textContent).toBe(`Snoozed: ${ALERT.title}`);
  });
});

describe('AlertsScreen — dismissing an alert', () => {
  it('hides the alert with no deadline, so it stays hidden until restored', () => {
    render(<AlertsScreen />);

    fireEvent.click(screen.getByTestId(`dismiss-alert-${ALERT.id}`));

    expect(screen.queryByTestId(`alert-card-${ALERT.id}`)).toBeNull();
    expect(dismissals().get(ALERT.id)?.until).toBeNull();
    expect(screen.getByTestId('alerts-action-live-region').textContent).toBe(`Dismissed: ${ALERT.title}`);
  });
});

describe('AlertsScreen — showing everything again', () => {
  it('counts a snoozed alert as hidden and restores it', () => {
    render(<AlertsScreen />);

    snooze('Snooze for a month');
    expect(screen.getByTestId('alerts-show-all').textContent).toContain('1 hidden');

    fireEvent.click(screen.getByTestId('alerts-show-all'));

    expect(screen.getByTestId(`alert-card-${ALERT.id}`)).toBeTruthy();
    expect(dismissals().size).toBe(0);
  });

  it('offers no "Show all" while nothing is hidden', () => {
    render(<AlertsScreen />);

    expect(screen.queryByTestId('alerts-show-all')).toBeNull();
  });
});
