import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { DEFAULT_HOTKEY_BINDINGS } from './hotkeys';
import { HotkeySettings } from './HotkeySettings';

/** Start the recorder on a row, then send the chord that should be captured. */
function record(actionId: string, key: string, mods: { ctrl?: boolean } = {}) {
  fireEvent.click(screen.getByTestId(`hotkey-record-${actionId}`));
  fireEvent.keyDown(document, { key, ctrlKey: mods.ctrl ?? false });
}

const bindings = () => usePreferencesStore.getState().hotkeyBindings;

beforeEach(() => {
  usePreferencesStore.setState({
    hotkeysEnabled: true,
    hotkeyBindings: DEFAULT_HOTKEY_BINDINGS,
    dashboardCommandPalette: true,
  });
  useModulesStore.setState({ intent: {} });
});

afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

describe('HotkeySettings', () => {
  it('shows each action’s current binding on its trigger', () => {
    render(<HotkeySettings />);
    expect(screen.getByTestId('hotkey-record-nav.inventory')).toHaveTextContent('F1');
    expect(screen.getByTestId('hotkey-record-command.palette')).toHaveTextContent('Ctrl+/');
  });

  it('reads "Not set" for an action that ships unbound', () => {
    render(<HotkeySettings />);
    expect(screen.getByTestId('hotkey-record-nav.reports')).toHaveTextContent('Not set');
  });

  it('records the next chord pressed as the new binding', () => {
    render(<HotkeySettings />);
    record('nav.reports', 'r', { ctrl: true });
    expect(bindings()['nav.reports']).toBe('Ctrl+R');
    expect(screen.getByTestId('hotkey-record-nav.reports')).toHaveTextContent('Ctrl+R');
  });

  it('ignores a bare modifier while the chord is still being assembled', () => {
    render(<HotkeySettings />);
    fireEvent.click(screen.getByTestId('hotkey-record-nav.reports'));
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    // Still recording — the binding is unchanged and the trigger still prompts.
    expect(bindings()['nav.reports']).toBe('');
    expect(screen.getByTestId('hotkey-record-nav.reports')).toHaveTextContent('Press a key…');
  });

  it('cancels on Escape rather than binding it — the recorder is never a trap', () => {
    render(<HotkeySettings />);
    record('nav.reports', 'Escape');
    expect(bindings()['nav.reports']).toBe('');
    expect(screen.getByTestId('hotkey-record-nav.reports')).toHaveTextContent('Not set');
  });

  it('refuses a browser-reserved key and explains why', () => {
    render(<HotkeySettings />);
    record('nav.reports', 'F5');
    expect(bindings()['nav.reports']).toBe('');
    expect(screen.getByTestId('setting-hotkeys-notice')).toHaveTextContent('F5 is reserved by your browser');
  });

  it('announces a successful rebind', () => {
    render(<HotkeySettings />);
    record('nav.reports', 'F7');
    expect(screen.getByTestId('setting-hotkeys-notice')).toHaveTextContent('F7 now opens Reports.');
  });

  it('flags both sides when two actions share a key', () => {
    render(<HotkeySettings />);
    record('nav.reports', 'F1'); // already Inventory's
    expect(screen.getAllByTestId('hotkey-conflict')).toHaveLength(2);
  });

  it('clears a binding from the row’s remove control', () => {
    render(<HotkeySettings />);
    fireEvent.click(screen.getByTestId('hotkey-clear-nav.inventory'));
    expect(bindings()['nav.inventory']).toBe('');
  });

  it('disables every row control while the master switch is off', () => {
    usePreferencesStore.setState({ hotkeysEnabled: false });
    render(<HotkeySettings />);
    expect(screen.getByTestId('hotkey-record-nav.inventory')).toBeDisabled();
    expect(screen.getByTestId('hotkey-clear-nav.inventory')).toBeDisabled();
  });

  it('restores every shipped default from the reset control', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'nav.inventory': 'Ctrl+Q' },
    });
    render(<HotkeySettings />);
    fireEvent.click(screen.getByTestId('setting-hotkeys-reset'));
    expect(bindings()).toEqual(DEFAULT_HOTKEY_BINDINGS);
  });

  it('hides the command-palette row when the palette itself is switched off', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    render(<HotkeySettings />);
    // Listing it would offer a live-looking control for a shortcut that can never fire.
    expect(screen.queryByTestId('hotkey-record-command.palette')).toBeNull();
    expect(screen.getByTestId('hotkey-record-command.settings')).toBeInTheDocument();
  });

  it('hides an action whose module is switched off', () => {
    useModulesStore.setState({ intent: { projects: false } });
    render(<HotkeySettings />);
    expect(screen.queryByTestId('hotkey-record-nav.projects')).toBeNull();
    expect(screen.getByTestId('hotkey-record-nav.inventory')).toBeInTheDocument();
  });
});
