import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
// The command-palette launcher self-gates on its own preference and pulls in unrelated
// deps; stub it out so the test targets only the quick-action buttons.
vi.mock('@/features/command-palette/HeaderSearch', () => ({ HeaderSearch: () => null }));

import { DashboardActions } from './DashboardActions';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  usePreferencesStore.setState({ dashboardQuickActions: true, dashboardCommandPalette: false });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('DashboardActions — Scan gating (Phase 6)', () => {
  it('shows the Scan quick action when the Scanner capability is on', () => {
    render(<DashboardActions />);
    expect(screen.queryByTestId('dashboard-scan')).not.toBeNull();
    expect(screen.queryByTestId('dashboard-add-item')).not.toBeNull();
  });

  it('hides the Scan quick action when Scanner is off, keeping Add item', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    render(<DashboardActions />);
    expect(screen.queryByTestId('dashboard-scan')).toBeNull();
    expect(screen.queryByTestId('dashboard-add-item')).not.toBeNull();
  });
});
