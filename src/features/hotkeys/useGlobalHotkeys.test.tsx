import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { pushModal, popModal } from '@/components/foundry/modal-stack';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCommandPaletteStore } from '@/features/command-palette/useCommandPaletteStore';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { DEFAULT_HOTKEY_BINDINGS } from './hotkeys';
import { useGlobalHotkeys } from './useGlobalHotkeys';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

/** Every module on, so feature gating never masks what a test is actually asserting. */
vi.mock('@/features/modules/useFeature', () => ({
  useEnabledFeatures: () => ({ has: () => true }),
}));

/** Dispatch a real keydown at the document, optionally from a given element. */
function press(
  key: string,
  options: {
    ctrl?: boolean;
    target?: HTMLElement;
  } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: options.ctrl ?? false,
    bubbles: true,
    cancelable: true,
  });
  (options.target ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  navigate.mockClear();
  usePreferencesStore.setState({
    hotkeysEnabled: true,
    hotkeyBindings: DEFAULT_HOTKEY_BINDINGS,
    dashboardCommandPalette: true,
  });
  useCommandPaletteStore.setState({ open: false });
  useSettingsDialog.setState({ open: false, initialTab: undefined });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useGlobalHotkeys', () => {
  it('navigates on a bound key, and claims the press', () => {
    renderHook(() => useGlobalHotkeys());
    const event = press('F1');
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves an unbound key entirely alone', () => {
    renderHook(() => useGlobalHotkeys());
    const event = press('F9');
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('binds nothing at all while the master switch is off', () => {
    usePreferencesStore.setState({ hotkeysEnabled: false });
    renderHook(() => useGlobalHotkeys());
    const event = press('F1');
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stands aside while a dialog owns the keyboard', () => {
    renderHook(() => useGlobalHotkeys());
    const token = pushModal();
    try {
      const event = press('F1');
      expect(navigate).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      popModal(token);
    }
    // …and resumes once the dialog closes.
    press('F1');
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
  });

  it('stands aside while the user is typing in a text field', () => {
    renderHook(() => useGlobalHotkeys());
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = press('F1', { target: input });
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('honours a rebound key and ignores the one it replaced', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'nav.inventory': 'Ctrl+I' },
    });
    renderHook(() => useGlobalHotkeys());
    press('F1');
    expect(navigate).not.toHaveBeenCalled();
    press('i', { ctrl: true });
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
  });

  it('does not fire an action the user has deliberately unbound', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'nav.inventory': '' },
    });
    renderHook(() => useGlobalHotkeys());
    expect(press('F1').defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('toggles the command palette on its chord', () => {
    renderHook(() => useGlobalHotkeys());
    press('/', { ctrl: true });
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('leaves the palette chord alone when the palette feature is off', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    renderHook(() => useGlobalHotkeys());
    const event = press('/', { ctrl: true });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens the Settings dialog on its chord', () => {
    renderHook(() => useGlobalHotkeys());
    press(',', { ctrl: true });
    expect(useSettingsDialog.getState().open).toBe(true);
  });

  it('opens Settings on the Hotkeys tab for the shortcuts action', () => {
    usePreferencesStore.setState({
      hotkeyBindings: { ...DEFAULT_HOTKEY_BINDINGS, 'command.hotkeys': 'F8' },
    });
    renderHook(() => useGlobalHotkeys());
    press('F8');
    expect(useSettingsDialog.getState()).toMatchObject({ open: true, initialTab: 'hotkeys' });
  });

  it('recovers from a corrupt persisted binding map rather than throwing', () => {
    usePreferencesStore.setState({
      // A map from an older build: one action missing, one holding a since-reserved chord.
      hotkeyBindings: { 'nav.inventory': 'F5' } as never,
    });
    renderHook(() => useGlobalHotkeys());
    // 'F5' was rejected, so Inventory is back on its shipped default.
    press('F1');
    expect(navigate).toHaveBeenCalledWith({ to: '/inventory' });
  });

  it('unbinds its listener on unmount', () => {
    const { unmount } = renderHook(() => useGlobalHotkeys());
    unmount();
    press('F1');
    expect(navigate).not.toHaveBeenCalled();
  });
});
