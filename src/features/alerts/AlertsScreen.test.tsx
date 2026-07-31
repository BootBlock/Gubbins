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

/**
 * Whether the stubbed feed reports its custom-field due-date read as truncated (W1a). Mutable so
 * one test can turn it on without a second `vi.mock` factory.
 */
let fieldDueTruncated = false;

/** One custom-field due-date alert, so the `field-due` section exists to hang the notice off. */
const FIELD_DUE_ALERT: Alert = {
  id: 'field-due:policy-1:def-1:2026-07-01',
  kind: 'field-due',
  severity: 'critical',
  title: 'Renewal date passed — Studio insurance',
  detail: '"Renewal date" was due on 2026-07-01.',
  dueAt: '2026-07-01T00:00:00.000Z',
  target: { route: '/inventory', itemId: 'policy-1', itemName: 'Studio insurance' },
};

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
    const all = fieldDueTruncated ? [ALERT, FIELD_DUE_ALERT] : [ALERT];
    return {
      alerts: applyDismissals(all, dismissals, Date.now()),
      allAlerts: all,
      isLoading: false,
      isError: false,
      fieldDueTruncated,
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
  fieldDueTruncated = false;
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

/**
 * The alert list can be taken away as a file (issue #132). The menu itself is stubbed here — its
 * download and toast machinery has its own suite — so these assert only what this screen owns:
 * that it offers the control at all, and gates it on there being something to write.
 */
describe('AlertsScreen — export', () => {
  it('offers an export for the alert list', () => {
    render(<AlertsScreen />);
    expect(screen.getByTestId('export-alerts')).toBeInTheDocument();
  });

  it('disables it once every alert is hidden, since the file would be empty', () => {
    render(<AlertsScreen />);
    // Dismiss the only alert; the export has nothing left to write.
    fireEvent.click(screen.getByTestId(`dismiss-alert-${ALERT.id}`));
    expect(screen.getByTestId('export-alerts')).toBeDisabled();
  });
});

/**
 * A capped feed must say so. The custom-field due-date lane reads every page and reports when it
 * stopped (issues #606/#607) — the whole point being that the shortfall is never silent, so the
 * screen has to actually render it, and only against the lane it is about.
 */
describe('AlertsScreen — the custom-field due-date lane is honest about truncation', () => {
  it("says so, inside that lane's section, when the read hit its ceiling", () => {
    fieldDueTruncated = true;
    render(<AlertsScreen />);

    const notice = screen.getByTestId('alerts-field-due-truncated');
    expect(notice).toBeInTheDocument();
    // Scoped to its own section, not floated above the whole feed — the other four lanes are
    // complete and must not be cast into doubt.
    expect(notice.closest('section')?.getAttribute('aria-labelledby')).toBe('alerts-section-field-due');
  });

  it('says nothing when the whole set was read', () => {
    render(<AlertsScreen />);
    expect(screen.queryByTestId('alerts-field-due-truncated')).toBeNull();
  });
});
