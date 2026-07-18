import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { DEFAULT_HOTKEY_BINDINGS } from './hotkeys';
import { SEQUENCE_TIMEOUT_MS } from './useGlobalHotkeys';
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
    expect(screen.getByTestId('hotkey-record-action.toggleTheme')).toHaveTextContent('Not set');
  });

  it('records the next chord pressed as the new binding', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'r', { ctrl: true });
    expect(bindings()['action.toggleTheme']).toBe('Ctrl+R');
    expect(screen.getByTestId('hotkey-record-action.toggleTheme')).toHaveTextContent('Ctrl+R');
  });

  it('ignores a bare modifier while the chord is still being assembled', () => {
    render(<HotkeySettings />);
    fireEvent.click(screen.getByTestId('hotkey-record-action.toggleTheme'));
    fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
    // Still recording — the binding is unchanged and the trigger still prompts.
    expect(bindings()['action.toggleTheme']).toBe('');
    expect(screen.getByTestId('hotkey-record-action.toggleTheme')).toHaveTextContent('Press a key…');
  });

  it('cancels on Escape rather than binding it — the recorder is never a trap', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'Escape');
    expect(bindings()['action.toggleTheme']).toBe('');
    expect(screen.getByTestId('hotkey-record-action.toggleTheme')).toHaveTextContent('Not set');
  });

  it('refuses a browser-reserved key and explains why', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'F5');
    expect(bindings()['action.toggleTheme']).toBe('');
    expect(screen.getByTestId('setting-hotkeys-notice')).toHaveTextContent('F5 is reserved by your browser');
  });

  it('announces a successful rebind', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'F7');
    expect(screen.getByTestId('setting-hotkeys-notice')).toHaveTextContent(
      'F7 is now the shortcut for Toggle light/dark.',
    );
  });

  it('flags both sides when two actions share a key', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'F1'); // already Inventory's
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

  // --- Sequences, presets and inline conflict resolution (issue #127) ---

  it('shows a sequence binding on its trigger', () => {
    render(<HotkeySettings />);
    expect(screen.getByTestId('hotkey-record-nav.reports')).toHaveTextContent('G R');
  });

  it('upgrades a just-recorded chord into a sequence when a second key follows', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'g');
    // Committed immediately as a single chord — binding one key still costs one press.
    expect(bindings()['action.toggleTheme']).toBe('G');
    // …and the row stays receptive, so a second key extends it in place.
    fireEvent.keyDown(document, { key: 't' });
    expect(bindings()['action.toggleTheme']).toBe('G T');
  });

  it('stops extending once the window has passed', () => {
    vi.useFakeTimers();
    try {
      render(<HotkeySettings />);
      record('action.toggleTheme', 'g');
      act(() => {
        vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);
      });
      fireEvent.keyDown(document, { key: 't' });
      expect(bindings()['action.toggleTheme']).toBe('G');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the single chord when the user declines to extend with Escape', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'g');
    fireEvent.keyDown(document, { key: 'Escape' });
    // Escape here means "I'm done", not "undo" — the chord was already asked for and granted.
    expect(bindings()['action.toggleTheme']).toBe('G');
  });

  it('lets Tab leave the row instead of becoming the second chord', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'g');
    const tab = fireEvent.keyDown(document, { key: 'Tab' });
    // Otherwise a keyboard user could not step off a row they had just bound without silently
    // turning their new binding into a sequence.
    expect(bindings()['action.toggleTheme']).toBe('G');
    // `fireEvent` returns false when the handler called preventDefault — Tab must stay unclaimed.
    expect(tab).toBe(true);
  });

  it('does not treat Enter or the arrow keys as a second chord either', () => {
    for (const key of ['Enter', 'ArrowDown']) {
      cleanup();
      usePreferencesStore.setState({ hotkeyBindings: DEFAULT_HOTKEY_BINDINGS });
      render(<HotkeySettings />);
      record('action.toggleTheme', 'g');
      fireEvent.keyDown(document, { key });
      expect(bindings()['action.toggleTheme'], key).toBe('G');
    }
  });

  it('offers to unbind the rival that shares a key, and does so', () => {
    render(<HotkeySettings />);
    record('action.toggleTheme', 'F1'); // already Inventory's
    expect(screen.getAllByTestId('hotkey-conflict')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('hotkey-unbind-rival-action.toggleTheme'));
    expect(bindings()['nav.inventory']).toBe('');
    expect(bindings()['action.toggleTheme']).toBe('F1');
    expect(screen.queryAllByTestId('hotkey-conflict')).toHaveLength(0);
  });

  it('applies a preset scheme only once the apply control is pressed', () => {
    render(<HotkeySettings />);
    fireEvent.click(screen.getByTestId('setting-hotkeys-preset'));
    fireEvent.click(screen.getByRole('option', { name: 'Vim-flavoured' }));
    // Selecting alone must not overwrite every row — that needs a deliberate press.
    expect(bindings()['nav.inventory']).toBe('F1');
    fireEvent.click(screen.getByTestId('setting-hotkeys-preset-apply'));
    expect(bindings()['nav.inventory']).toBe('G I');
    expect(screen.getByTestId('setting-hotkeys-notice')).toHaveTextContent('Vim-flavoured');
  });
});
