/**
 * Component tests for SettingsScreen feature gating (Modular UI Phase 7).
 *
 * When a capability is off, its settings must disappear too so no orphaned control is left
 * behind: the whole Scanner group drops (`scanner`), and the "expiring soon" window
 * (`perishables`) and budget-warn threshold (`projects`) rows drop individually — while their
 * Inventory & lifecycle section stays for the always-present low-stock thresholds (no empty
 * section shell).
 *
 * The screen's heavy children (router Link, the global nav, Danger Zone, Database maintenance,
 * Storage triage) are stubbed so the test stays in happy-dom with no providers; the preferences
 * and modules stores are the real Zustand stores.
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
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));
vi.mock('@/features/danger-zone/DangerZone', () => ({ DangerZone: () => null }));
vi.mock('@/features/maintenance', () => ({ DatabaseMaintenance: () => null }));
vi.mock('@/features/storage/StorageTriageDialog', () => ({ StorageTriageDialog: () => null }));

import { SettingsScreen } from './SettingsScreen';
import { useModulesStore } from '@/state/stores/useModulesStore';

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('SettingsScreen — all features on (default)', () => {
  it('shows the Scanner group, the expiring-soon window and the budget-warn threshold', () => {
    render(<SettingsScreen />);
    expect(screen.queryByTestId('setting-scanner-symbology')).not.toBeNull();
    expect(screen.queryByTestId('setting-expiry-days')).not.toBeNull();
    expect(screen.queryByTestId('setting-budget-warn')).not.toBeNull();
  });
});

describe('SettingsScreen — Live camera scanning off', () => {
  it('drops the whole Scanner group, leaving the other sections intact', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    render(<SettingsScreen />);
    expect(screen.queryByTestId('setting-scanner-symbology')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-beep')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-haptics')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Scanner' })).toBeNull();
    // Unrelated sections remain (Labels & QR codes stays — printed labels work regardless).
    expect(screen.queryByTestId('setting-label-base-url')).not.toBeNull();
    expect(screen.queryByTestId('setting-currency')).not.toBeNull();
  });
});

describe('SettingsScreen — Expiry tracking off', () => {
  it('drops the expiring-soon window row but keeps the Inventory & lifecycle section', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    render(<SettingsScreen />);
    expect(screen.queryByTestId('setting-expiry-days')).toBeNull();
    // The section stays for the always-present low-stock thresholds — no empty section shell.
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
    expect(screen.queryByTestId('setting-low-stock-gauge')).not.toBeNull();
  });
});

describe('SettingsScreen — Projects off', () => {
  it('drops the budget-warn threshold row but keeps the low-stock thresholds', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<SettingsScreen />);
    expect(screen.queryByTestId('setting-budget-warn')).toBeNull();
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
  });
});
