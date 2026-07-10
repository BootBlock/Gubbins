/**
 * Component tests for the Modules manager screen (modular-ui-plan §4, Phase 3).
 *
 * Exercises the three behaviours the screen owns: presets that reflect live in the toggle
 * list, the dependency-cascade confirmations (disable a feature with dependents / enable a
 * feature with off dependencies, mutating intent only on confirm), and the locked core
 * features. Dependencies are stubbed at the module boundary so the test stays in happy-dom
 * with no router or QueryClient. The Foundry Select is click-driven (open the combobox,
 * click the option) per the component-test conventions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Plain-anchor Link so PageHeader renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The global nav menu has its own suite; stub it (foundry-page-header convention) so this
// screen test needs no router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// The header's command-palette search pulls the preferences store — stub it out.
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

// Render every icon as a text-free span so combobox/label text stays clean.
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { ModulesScreen } from './ModulesScreen';
import { useModulesStore } from '@/state/stores/useModulesStore';

beforeEach(() => {
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
});

/** Open a feature's on/off combobox and click one of its options. */
function chooseToggle(featureLabel: string, option: 'On' | 'Off') {
  fireEvent.click(screen.getByRole('combobox', { name: `${featureLabel} module` }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('ModulesScreen — layout & core lock', () => {
  it('renders the header, preset cards and grouped toggles', () => {
    render(<ModulesScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Modules' })).toBeTruthy();
    // Every preset card is present.
    for (const id of ['everything', 'minimal', 'home-hobby', 'maker-workshop', 'asset-equipment']) {
      expect(screen.getByTestId(`preset-${id}`)).toBeTruthy();
    }
    // Group headings.
    expect(screen.getByRole('heading', { name: 'Pages' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeTruthy();
  });

  it('shows core features locked (Always on) with no toggle', () => {
    render(<ModulesScreen />);
    for (const id of ['dashboard', 'inventory', 'settings', 'about']) {
      expect(screen.getByTestId(`module-locked-${id}`).textContent).toContain('Always on');
      expect(screen.queryByRole('combobox', { name: new RegExp(`^${id}`, 'i') })).toBeNull();
    }
    // Inventory can never be turned off — no toggle exists for it.
    expect(screen.queryByRole('combobox', { name: 'Inventory module' })).toBeNull();
  });

  it('marks the everything preset active by default (nothing hidden)', () => {
    render(<ModulesScreen />);
    expect(screen.getByTestId('preset-everything').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('preset-minimal').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ModulesScreen — presets reflect live in the toggle list', () => {
  it('applying Minimal switches every optional toggle off; Everything restores them', () => {
    render(<ModulesScreen />);
    expect(screen.getByRole('combobox', { name: 'Reports module' })).toHaveTextContent('On');

    fireEvent.click(screen.getByTestId('preset-minimal'));
    expect(screen.getByRole('combobox', { name: 'Reports module' })).toHaveTextContent('Off');
    expect(screen.getByTestId('preset-minimal').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('preset-everything'));
    expect(screen.getByRole('combobox', { name: 'Reports module' })).toHaveTextContent('On');
  });
});

describe('ModulesScreen — dependency cascade on disable', () => {
  it('confirms before hiding a feature with effective dependents, cascading only on confirm', () => {
    render(<ModulesScreen />);
    chooseToggle('Contacts', 'Off');

    // A confirmation naming the dependents appears; intent is NOT yet mutated.
    const dialog = screen.getByRole('dialog', { name: 'Hide Contacts?' });
    expect(dialog.textContent).toContain('Purchase orders');
    expect(dialog.textContent).toContain('Bookings');
    expect(useModulesStore.getState().intent.contacts).toBeUndefined();

    fireEvent.click(screen.getByTestId('confirm-cascade'));

    expect(useModulesStore.getState().intent.contacts).toBe(false);
    // Dependents now resolve off (their own intent is untouched — restored if contacts returns).
    expect(screen.getByRole('combobox', { name: 'Purchase orders module' })).toHaveTextContent('Off');
    expect(screen.getByRole('combobox', { name: 'Bookings module' })).toHaveTextContent('Off');
  });

  it('cancelling the confirmation leaves intent untouched', () => {
    render(<ModulesScreen />);
    chooseToggle('Contacts', 'Off');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useModulesStore.getState().intent.contacts).toBeUndefined();
    expect(screen.getByRole('combobox', { name: 'Contacts module' })).toHaveTextContent('On');
  });

  it('applies a self-contained toggle immediately with no confirmation', () => {
    render(<ModulesScreen />);
    // Activity has no dependents, so turning it off needs no confirmation.
    chooseToggle('Activity', 'Off');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useModulesStore.getState().intent.activity).toBe(false);
  });
});

describe('ModulesScreen — dependency cascade on enable', () => {
  it('offers to switch on missing dependencies when enabling a feature', () => {
    // Start with contacts off, so purchase-orders resolves off too.
    useModulesStore.setState({ intent: { contacts: false } });
    render(<ModulesScreen />);
    expect(screen.getByRole('combobox', { name: 'Purchase orders module' })).toHaveTextContent('Off');

    chooseToggle('Purchase orders', 'On');

    const dialog = screen.getByRole('dialog', { name: 'Show Purchase orders?' });
    expect(dialog.textContent).toContain('Contacts');
    // Nothing changes until confirmed.
    expect(useModulesStore.getState().intent['purchase-orders']).toBeUndefined();

    fireEvent.click(screen.getByTestId('confirm-cascade'));

    const intent = useModulesStore.getState().intent;
    expect(intent['purchase-orders']).toBe(true);
    expect(intent.contacts).toBe(true);
  });
});

describe('ModulesScreen — run setup again', () => {
  it('re-opens the first-run chooser and applies the picked preset', () => {
    // Already past first-run; the button re-opens the wizard via local mount state.
    useModulesStore.setState({ intent: {}, firstRunComplete: true });
    render(<ModulesScreen />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('modules-run-setup-again'));
    expect(screen.getByRole('dialog', { name: 'Set up your modules' })).toBeTruthy();

    fireEvent.click(screen.getByTestId('first-run-preset-minimal'));
    // The wizard now has a second (animation) step; advance, then finish.
    fireEvent.click(screen.getByTestId('first-run-next'));
    fireEvent.click(screen.getByTestId('first-run-use'));

    // Dialog closes and the preset is applied live in the toggle list.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useModulesStore.getState().intent.reports).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Reports module' })).toHaveTextContent('Off');
  });
});

describe('ModulesScreen — search', () => {
  it('filters the toggle list and shows an empty state for no matches', () => {
    render(<ModulesScreen />);
    const search = screen.getByTestId('modules-search');

    fireEvent.change(search, { target: { value: 'projects' } });
    expect(screen.getByRole('combobox', { name: 'Projects module' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Reports module' })).toBeNull();

    fireEvent.change(search, { target: { value: 'zzzznope' } });
    expect(screen.getByTestId('modules-no-results')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
