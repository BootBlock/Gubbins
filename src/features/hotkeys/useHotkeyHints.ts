/**
 * "What key does this?" — the lookup behind showing an accelerator beside the action itself
 * (issue #127), the way a desktop menu prints `Ctrl+S` next to Save.
 *
 * The navigation menu and the command palette both list actions the shortcut registry already
 * knows about; printing the bound key there reinforces it at the moment the user is reaching for
 * the mouse to do the same thing, which is the moment a shortcut is actually learnable. Neither
 * surface should have to know how bindings are stored, so both ask this.
 *
 * Returns display strings (already platform-spelled), keyed by route for navigation and by
 * command for the rest. An action that is unbound, gated off, or whose master switch is off is
 * simply absent — the caller renders nothing rather than an empty cap.
 */
import { useMemo } from 'react';
import type { AppRoutePath } from '@/components/nav/nav-destinations';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermissionCheck } from '@/features/users/usePermission';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  HOTKEY_ACTIONS,
  displayBinding,
  isMacKeyboard,
  normaliseHotkeyBindings,
  type HotkeyCommand,
  hotkeyPermission,
} from './hotkeys';

/** Spell modifiers the macOS way (`⌘⇧K`) rather than `Ctrl+Shift+K`; settled once at load. */
const IS_MAC = isMacKeyboard();

export interface HotkeyHints {
  /** Display binding for the shortcut that navigates to a route, if any. */
  readonly forRoute: (to: AppRoutePath) => string | undefined;
  /** Display binding for the shortcut running a command, if any. */
  readonly forCommand: (command: HotkeyCommand) => string | undefined;
}

export function useHotkeyHints(): HotkeyHints {
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const stored = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const enabledFeatures = useEnabledFeatures();
  const allows = usePermissionCheck();

  return useMemo(() => {
    const byRoute = new Map<AppRoutePath, string>();
    const byCommand = new Map<HotkeyCommand, string>();
    if (enabled) {
      const bindings = normaliseHotkeyBindings(stored);
      for (const action of HOTKEY_ACTIONS) {
        const binding = bindings[action.id];
        if (binding === '') continue;
        if (action.feature !== undefined && !enabledFeatures.has(action.feature)) continue;
        if (!allows(hotkeyPermission(action))) continue;
        if (action.requiresPref === 'dashboardCommandPalette' && !paletteEnabled) continue;
        const shown = displayBinding(binding, IS_MAC);
        if (shown === '') continue;
        if (action.effect.kind === 'navigate') byRoute.set(action.effect.to, shown);
        else byCommand.set(action.effect.command, shown);
      }
    }
    return {
      forRoute: (to) => byRoute.get(to),
      forCommand: (command) => byCommand.get(command),
    };
  }, [enabled, stored, paletteEnabled, enabledFeatures, allows]);
}
