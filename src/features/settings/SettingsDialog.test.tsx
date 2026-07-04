/**
 * Component tests for the Settings dialog's feature gating (Modular UI Phase 7).
 *
 * When a capability is off, its settings must disappear too so no orphaned control is left
 * behind: the whole Scanner section drops (`scanner`), and the "expiring soon" window
 * (`perishables`) and budget-warn threshold (`projects`) rows drop individually — while their
 * Inventory tab keeps the always-present low-stock thresholds (no empty section shell).
 *
 * The dialog is a {@link RailModal}: only the active tab's panel is mounted, so each test
 * clicks into the relevant rail tab before asserting. The dialog's heavy children (router
 * Link, Danger zone, Database maintenance, Storage triage) are stubbed so the test stays in
 * happy-dom with no providers; the preferences and modules stores are the real Zustand stores.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/features/danger-zone/DangerZone', () => ({ DangerZone: () => null }));
vi.mock('@/features/maintenance', () => ({ DatabaseMaintenance: () => null }));
vi.mock('@/features/storage/StorageTriageDialog', () => ({ StorageTriageDialog: () => null }));
// The card-field picker (E1) fetches the custom-field catalog, so it needs a QueryClient;
// stub it out like the other data-heavy children so this test stays provider-free.
vi.mock('@/features/inventory/components/CardFieldsSetting', () => ({ CardFieldsSetting: () => null }));

import SettingsDialog from './SettingsDialog';
import { useModulesStore } from '@/state/stores/useModulesStore';

/** Open the dialog fresh and click into the named rail tab. */
function renderTab(tabName: string) {
  render(<SettingsDialog open onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: tabName }));
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('SettingsDialog — all features on (default)', () => {
  it('shows the Scanner section, the expiring-soon window and the budget-warn threshold', () => {
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-scanner-symbology')).not.toBeNull();

    cleanup();
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-expiry-days')).not.toBeNull();
    expect(screen.queryByTestId('setting-budget-warn')).not.toBeNull();
  });
});

describe('SettingsDialog — Live camera scanning off', () => {
  it('drops the whole Scanner section, leaving Labels & QR codes intact', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-scanner-symbology')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-beep')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-haptics')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Scanner' })).toBeNull();
    // The Labels & QR codes section stays — printed labels work regardless of the scanner.
    expect(screen.queryByTestId('setting-label-base-url')).not.toBeNull();
  });
});

describe('SettingsDialog — Expiry tracking off', () => {
  it('drops the expiring-soon window row but keeps the low-stock thresholds', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-expiry-days')).toBeNull();
    // The section stays for the always-present low-stock thresholds — no empty section shell.
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
    expect(screen.queryByTestId('setting-low-stock-gauge')).not.toBeNull();
  });
});

describe('SettingsDialog — Projects off', () => {
  it('drops the budget-warn threshold row but keeps the low-stock thresholds', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-budget-warn')).toBeNull();
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
  });
});

describe('SettingsDialog — nav-tile count pickers (A1)', () => {
  it('shows a metric picker for each configurable tile on the Dashboard tab', () => {
    renderTab('Dashboard');
    expect(screen.queryByTestId('setting-nav-count-/projects')).not.toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/purchase-orders')).not.toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/bookings')).not.toBeNull();
  });

  it('drops a tile’s picker when that tile’s feature is switched off', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    renderTab('Dashboard');
    expect(screen.queryByTestId('setting-nav-count-/projects')).toBeNull();
    // The other tiles' pickers remain.
    expect(screen.queryByTestId('setting-nav-count-/bookings')).not.toBeNull();
  });

  it('drops the whole section only when every configurable tile is off', () => {
    // Bookings & purchase-orders depend on contacts, so turning contacts + projects off
    // removes all three configurable tiles — and with them the section heading.
    useModulesStore.getState().setFeatureIntent('projects', false);
    useModulesStore.getState().setFeatureIntent('contacts', false);
    renderTab('Dashboard');
    expect(screen.queryByTestId('setting-nav-count-/projects')).toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/purchase-orders')).toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/bookings')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nav tile counts' })).toBeNull();
  });
});
