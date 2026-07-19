/**
 * Per-tile crash containment (issue #313): a widget that throws while rendering must degrade
 * to its own error card, leaving the rest of the board intact — rather than escaping to the
 * route boundary and blanking the whole dashboard.
 *
 * Lives apart from `DashboardGrid.test.tsx` because it needs its own widget registry mock
 * (one deliberately-throwing widget), and `vi.mock` is per-file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('./widgets', () => {
  const defs = [
    { id: 'alpha', title: 'Alpha', icon: null, to: '/inventory', Component: () => <p>Alpha body</p> },
    {
      id: 'boom',
      title: 'Boom',
      icon: null,
      to: '/inventory',
      Component: () => {
        throw new Error('widget exploded');
      },
    },
    { id: 'gamma', title: 'Gamma', icon: null, to: '/inventory', Component: () => <p>Gamma body</p> },
  ];
  return {
    DASHBOARD_WIDGETS: defs,
    DASHBOARD_WIDGET_IDS: defs.map((d) => d.id),
    widgetById: (id: string) => defs.find((d) => d.id === id),
    useHealthyWidgetIds: () => new Set<string>(),
    WidgetCrashFallback: () => <p data-testid="widget-crashed">Widget unavailable</p>,
  };
});

import { DashboardGrid } from './DashboardGrid';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useDashboardCustomise } from './useDashboardCustomise';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// React logs the caught error (and the boundary's own `console.error`); both are expected here.
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
  usePreferencesStore.setState({ hideHealthyDashboardCards: false });
});
afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
});

describe('DashboardGrid — one crashing widget (issue #313)', () => {
  it('contains the crash to its own tile and leaves the board rendered', () => {
    render(<DashboardGrid />);

    // The crashed tile still occupies its cell, showing the shell's error state.
    expect(screen.getByTestId('widget-boom')).toBeInTheDocument();
    expect(screen.getByTestId('widget-boom')).toContainElement(screen.getByTestId('widget-crashed'));

    // Every other widget rendered normally — the board did not go down with it.
    expect(screen.getByText('Alpha body')).toBeInTheDocument();
    expect(screen.getByText('Gamma body')).toBeInTheDocument();
  });

  it('logs the failure so the crash is still diagnosable', () => {
    render(<DashboardGrid />);
    expect(
      errorSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('dashboard widget "boom"'),
      ),
    ).toBe(true);
  });
});
