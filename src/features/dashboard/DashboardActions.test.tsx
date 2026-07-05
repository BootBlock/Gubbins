import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  usePreferencesStore.setState({ dashboardQuickActions: true, dashboardCommandPalette: false });
  useInventoryEntry.getState().clearIntent();
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
  useInventoryEntry.getState().clearIntent();
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

describe('DashboardActions — Add-item split button', () => {
  it('records the `add` intent when the primary half is activated', async () => {
    const user = userEvent.setup();
    render(<DashboardActions />);
    await user.click(screen.getByTestId('dashboard-add-item'));
    expect(useInventoryEntry.getState().pendingIntent).toBe('add');
  });

  it('opens a menu with Import… behind the attached chevron', async () => {
    const user = userEvent.setup();
    render(<DashboardActions />);
    // The Import row lives behind the split-button dropdown — hidden until the chevron opens it.
    expect(screen.queryByTestId('dashboard-import')).toBeNull();
    await user.click(screen.getByTestId('dashboard-add-menu'));
    expect(screen.getByTestId('dashboard-import')).not.toBeNull();
  });

  it('records the `import` intent (opening the Import dialog on arrival) from the menu', async () => {
    const user = userEvent.setup();
    render(<DashboardActions />);
    await user.click(screen.getByTestId('dashboard-add-menu'));
    await user.click(screen.getByTestId('dashboard-import'));
    expect(useInventoryEntry.getState().pendingIntent).toBe('import');
  });
});
