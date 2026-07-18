/**
 * The dispatcher's behaviour for what issue #127 added: two-key sequences (including expiry),
 * the new action commands, and contextual dispatch to whichever screen is offering a handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { DEFAULT_HOTKEY_BINDINGS } from './hotkeys';
import { useGlobalHotkeys, SEQUENCE_TIMEOUT_MS } from './useGlobalHotkeys';
import { useHotkeyIntent } from './useHotkeyIntent';
import { useHotkeyScopeStore } from './useHotkeyScope';
import { useShortcutsOverlay } from './useShortcutsOverlay';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

/** Every module on, so feature gating never masks what a test is actually asserting. */
vi.mock('@/features/modules/useFeature', () => ({
  useEnabledFeatures: () => ({ has: () => true }),
}));

/** Dispatch a real keydown at the document. */
function press(key: string, options: { shift?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: options.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  navigate.mockClear();
  usePreferencesStore.setState({
    hotkeysEnabled: true,
    hotkeyBindings: DEFAULT_HOTKEY_BINDINGS,
    dashboardCommandPalette: true,
    fullWidth: false,
    mode: 'light',
  });
  useHotkeyScopeStore.setState({ entries: [] });
  useHotkeyIntent.setState({ pending: null });
  useShortcutsOverlay.setState({ open: false });
  useInventoryEntry.setState({ pendingIntent: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = '';
});

describe('two-key sequences', () => {
  it('navigates once the second key completes the sequence', () => {
    renderHook(() => useGlobalHotkeys());
    press('g');
    expect(navigate).not.toHaveBeenCalled(); // the prefix alone commits to nothing
    press('r');
    expect(navigate).toHaveBeenCalledWith({ to: '/reports' });
  });

  it('claims the prefix press, so the key never also types', () => {
    renderHook(() => useGlobalHotkeys());
    expect(press('g').defaultPrevented).toBe(true);
  });

  it('forgets an abandoned prefix once it expires', () => {
    renderHook(() => useGlobalHotkeys());
    press('g');
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);
    press('r');
    // `R` alone is bound to nothing, so an expired prefix must leave it inert rather than
    // completing a navigation the user started ages ago.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still completes just inside the timeout', () => {
    renderHook(() => useGlobalHotkeys());
    press('g');
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 10);
    press('r');
    expect(navigate).toHaveBeenCalledWith({ to: '/reports' });
  });

  it('re-evaluates a chord that completes nothing rather than eating it', () => {
    renderHook(() => useGlobalHotkeys());
    press('g');
    press('F1');
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
  });
});

describe('action shortcuts', () => {
  it('opens the cheat sheet on ?', () => {
    renderHook(() => useGlobalHotkeys());
    press('?', { shift: true });
    expect(useShortcutsOverlay.getState().open).toBe(true);
  });

  it('toggles full width', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'action.toggleFullWidth': 'W' },
    });
    renderHook(() => useGlobalHotkeys());
    press('w');
    expect(usePreferencesStore.getState().fullWidth).toBe(true);
  });

  it('toggles to the opposite of the theme on screen', () => {
    usePreferencesStore.setState({
      mode: 'light',
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'action.toggleTheme': 'T' },
    });
    renderHook(() => useGlobalHotkeys());
    press('t');
    expect(usePreferencesStore.getState().mode).toBe('dark');
    press('t');
    expect(usePreferencesStore.getState().mode).toBe('light');
  });

  it('asks Inventory to open its Add dialog, and goes there', () => {
    usePreferencesStore.setState({ hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'action.addItem': 'A' } });
    renderHook(() => useGlobalHotkeys());
    press('a');
    expect(useInventoryEntry.getState().pendingIntent).toBe('add');
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
  });

  it('leaves a create intent for Projects, and goes there', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'action.newProject': 'P' },
    });
    renderHook(() => useGlobalHotkeys());
    press('p');
    expect(useHotkeyIntent.getState().pending).toBe('new-project');
    expect(navigate).toHaveBeenCalledWith({ to: '/projects' });
  });
});

describe('contextual shortcuts', () => {
  it('runs the current screen’s "new" handler on N', () => {
    const onNew = vi.fn();
    useHotkeyScopeStore.setState({ entries: [{ id: 'screen', onNew }] });
    renderHook(() => useGlobalHotkeys());
    const event = press('n');
    expect(onNew).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the key to the browser when no screen offers it', () => {
    renderHook(() => useGlobalHotkeys());
    const event = press('n');
    // Not claimed — otherwise `/` and `N` would be dead keys on every screen without a handler.
    expect(event.defaultPrevented).toBe(false);
  });

  it('focuses the current screen’s search on /', () => {
    const onSearch = vi.fn();
    useHotkeyScopeStore.setState({ entries: [{ id: 'screen', onSearch }] });
    renderHook(() => useGlobalHotkeys());
    press('/');
    expect(onSearch).toHaveBeenCalledOnce();
  });
});
