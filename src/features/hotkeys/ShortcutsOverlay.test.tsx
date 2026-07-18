/**
 * The `?` shortcuts cheat sheet (issue #127).
 *
 * The rule worth locking down is that the sheet describes *this moment*: it lists only shortcuts
 * that could actually fire right now, so it can never teach the user a key that does nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { DEFAULT_HOTKEY_BINDINGS } from './hotkeys';
import ShortcutsOverlay from './ShortcutsOverlay';
import { useHotkeyScopeStore } from './useHotkeyScope';

/** Every module on, so feature gating never masks what a test is actually asserting. */
vi.mock('@/features/modules/useFeature', () => ({
  useEnabledFeatures: () => ({ has: () => true }),
}));

const onClose = vi.fn();

beforeEach(() => {
  usePreferencesStore.setState({
    hotkeysEnabled: true,
    hotkeyBindings: DEFAULT_HOTKEY_BINDINGS,
    dashboardCommandPalette: true,
  });
  useHotkeyScopeStore.setState({ entries: [] });
});

afterEach(() => {
  cleanup();
  useHotkeyScopeStore.setState({ entries: [] });
  onClose.mockClear();
});

describe('ShortcutsOverlay', () => {
  it('lists a bound shortcut with its key', () => {
    render(<ShortcutsOverlay onClose={onClose} />);
    const row = screen.getByTestId('shortcut-row-nav.inventory');
    expect(row).toHaveTextContent('Inventory');
    expect(row).toHaveTextContent('F1');
  });

  it('shows a sequence binding as two separate keys', () => {
    render(<ShortcutsOverlay onClose={onClose} />);
    const row = screen.getByTestId('shortcut-row-nav.reports');
    // Rendered as caps with a "then" between, so it can't be read as one held-down chord.
    expect(row).toHaveTextContent('G');
    expect(row).toHaveTextContent('then');
    expect(row).toHaveTextContent('R');
  });

  it('omits an action that ships unbound', () => {
    render(<ShortcutsOverlay onClose={onClose} />);
    expect(screen.queryByTestId('shortcut-row-action.toggleTheme')).toBeNull();
  });

  it('omits a contextual shortcut no screen currently offers', () => {
    // `N` is bound, but with nothing registered it would do nothing — listing it would be a lie.
    render(<ShortcutsOverlay onClose={onClose} />);
    expect(screen.queryByTestId('shortcut-row-screen.new')).toBeNull();
  });

  it('lists a contextual shortcut once a screen offers it', () => {
    useHotkeyScopeStore.setState({ entries: [{ id: 'scope-1', onNew: () => {} }] });
    render(<ShortcutsOverlay onClose={onClose} />);
    expect(screen.getByTestId('shortcut-row-screen.new')).toHaveTextContent('New (current screen)');
    // Still nothing for search — that screen offers no search box.
    expect(screen.queryByTestId('shortcut-row-screen.search')).toBeNull();
  });

  it('says so when shortcuts are switched off entirely', () => {
    usePreferencesStore.setState({ hotkeysEnabled: false });
    render(<ShortcutsOverlay onClose={onClose} />);
    expect(screen.getByRole('status')).toHaveTextContent('Keyboard shortcuts are switched off.');
    expect(screen.queryByTestId('shortcut-row-nav.inventory')).toBeNull();
  });

  it('hides the command-palette row when the palette itself is off', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    render(<ShortcutsOverlay onClose={onClose} />);
    expect(screen.queryByTestId('shortcut-row-command.palette')).toBeNull();
  });

  it('closes itself before opening Settings, so Escape targets the right dialog', () => {
    const openSettings = vi.fn();
    useSettingsDialog.setState({ openSettings });
    render(<ShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByTestId('shortcuts-overlay-edit'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledWith('hotkeys');
  });
});
