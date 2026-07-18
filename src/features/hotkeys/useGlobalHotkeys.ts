/**
 * Binds the global keyboard shortcuts (issue #32) — the app's single document-level hotkey
 * listener, mounted once at the root layout.
 *
 * All of the decision-making lives in the pure {@link resolveHotkeyAction} seam; this hook is
 * only the wiring: read the current bindings, ask what the press means, perform it. The guards
 * before that question are the interesting part, and each exists for a specific failure:
 *
 * - **A dialog is open** → stand aside. A modal owns the keyboard while it's up (that's the
 *   `modal-stack` contract), so navigating out from under one would strand a half-finished
 *   form. This also fixes the old ad-hoc `Ctrl+/` listener, which fired through open dialogs.
 * - **The press landed in a text field** → stand aside, or typing `F1` into an item's notes
 *   would navigate away mid-sentence.
 * - **The user is already holding a browser chord we don't own** → only exact matches fire; a
 *   press with extra modifiers is somebody else's shortcut.
 *
 * The command-palette shortcut is registered here as an ordinary action rather than owning its
 * own listener, so there is one place where a key press becomes an app action — and so it is
 * rebindable like everything else.
 */
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { openModalCount } from '@/components/foundry';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { useCommandPaletteStore } from '@/features/command-palette/useCommandPaletteStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  bindingFromEvent,
  isMacKeyboard,
  isTypingTarget,
  normaliseHotkeyBindings,
  resolveHotkeyAction,
  type HotkeyAction,
} from './hotkeys';

/** Mac keyboards fold Command into the primary modifier — settled once, not per key press. */
const IS_MAC = isMacKeyboard();

export function useGlobalHotkeys(): void {
  const navigate = useNavigate();
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const bindings = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const enabledFeatures = useEnabledFeatures();

  useEffect(() => {
    if (!enabled) return;
    // Coerce once per binding change rather than on every key press — a stale persisted map
    // can never reach the matcher, and the hot path stays a map lookup.
    const resolved = normaliseHotkeyBindings(bindings);
    const isEnabled = (action: HotkeyAction): boolean => {
      if (action.feature !== undefined && !enabledFeatures.has(action.feature)) return false;
      if (action.requiresPref === 'dashboardCommandPalette' && !paletteEnabled) return false;
      return true;
    };

    const onKey = (event: globalThis.KeyboardEvent) => {
      // A modal owns the keyboard while it is open (see the module docstring).
      if (openModalCount() > 0) return;
      if (isTypingTarget(event.target as HTMLElement | null)) return;
      const binding = bindingFromEvent(event, IS_MAC);
      if (binding === null) return;
      const action = resolveHotkeyAction(resolved, binding, isEnabled);
      if (action === null) return;
      // Only now claim the press — everything above leaves it for the browser/page.
      event.preventDefault();
      if (action.effect.kind === 'navigate') {
        void navigate({ to: action.effect.to });
        return;
      }
      switch (action.effect.command) {
        case 'command-palette':
          useCommandPaletteStore.getState().toggle();
          return;
        case 'open-settings':
          useSettingsDialog.getState().openSettings();
          return;
        case 'open-hotkey-settings':
          useSettingsDialog.getState().openSettings('hotkeys');
          return;
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, bindings, paletteEnabled, enabledFeatures, navigate]);
}
