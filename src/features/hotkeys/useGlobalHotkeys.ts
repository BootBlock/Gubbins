/**
 * Binds the global keyboard shortcuts (issues #32, #127) — the app's single document-level hotkey
 * listener, mounted once at the root layout.
 *
 * All of the decision-making lives in the pure {@link stepHotkeySequence} seam; this hook is
 * only the wiring: read the current bindings, ask what the press means, perform it. The guards
 * before that question are the interesting part, and each exists for a specific failure:
 *
 * - **A dialog is open** → stand aside. A modal owns the keyboard while it's up (that's the
 *   `modal-stack` contract), so navigating out from under one would strand a half-finished
 *   form. This also fixes the old ad-hoc `Ctrl+/` listener, which fired through open dialogs.
 * - **The press landed in a text field** → stand aside, or typing `F1` into an item's notes
 *   would navigate away mid-sentence. This matters far more now that bare letters are bound.
 * - **The user is already holding a browser chord we don't own** → only exact matches fire; a
 *   press with extra modifiers is somebody else's shortcut.
 *
 * The command-palette shortcut is registered here as an ordinary action rather than owning its
 * own listener, so there is one place where a key press becomes an app action — and so it is
 * rebindable like everything else.
 *
 * **Sequences.** A binding may be two chords (`G R`). The first arms a pending prefix, held here
 * and expired by {@link SEQUENCE_TIMEOUT_MS} so an abandoned `G` can't lie in wait and turn an
 * unrelated keystroke minutes later into a navigation. The prefix press is claimed
 * (`preventDefault`) — it is ours the moment it arms — but a chord that completes nothing is
 * re-evaluated as a fresh press rather than swallowed.
 *
 * **Contextual actions.** `screen-new` / `screen-search` dispatch to whichever screen registered a
 * handler (see `useHotkeyScope`); with none registered the press is deliberately *not* claimed, so
 * `/` still types a slash on a screen that offers no search.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { openModalCount } from '@/components/foundry';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { useCommandPaletteStore } from '@/features/command-palette/useCommandPaletteStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { activeScopeHandler } from './useHotkeyScope';
import { useHotkeyIntent } from './useHotkeyIntent';
import { useShortcutsOverlay } from './useShortcutsOverlay';
import {
  bindingFromEvent,
  isMacKeyboard,
  isTypingTarget,
  normaliseHotkeyBindings,
  stepHotkeySequence,
  type HotkeyAction,
} from './hotkeys';

/** Mac keyboards fold Command into the primary modifier — settled once, not per key press. */
const IS_MAC = isMacKeyboard();

/**
 * How long a pending sequence prefix stays armed. Long enough not to punish a deliberate,
 * unhurried `G` … `R`, short enough that a forgotten prefix has expired by the time the user
 * touches the keyboard again — the same reasoning as the editors this convention comes from.
 */
export const SEQUENCE_TIMEOUT_MS = 1500;

export function useGlobalHotkeys(): void {
  const navigate = useNavigate();
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const bindings = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const enabledFeatures = useEnabledFeatures();
  // The armed sequence prefix, in a ref rather than state: it changes on a key press and must not
  // re-render the whole app (nor tear down and re-add the listener) to do so.
  const pending = useRef<string | null>(null);

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

    let expiry: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      pending.current = null;
      if (expiry !== undefined) clearTimeout(expiry);
      expiry = undefined;
    };

    /**
     * Run an action's effect. Returns whether it was actually handled — a contextual action with
     * no screen offering it is *not*, and the press must be left alone.
     */
    const perform = (action: HotkeyAction): boolean => {
      if (action.effect.kind === 'navigate') {
        void navigate({ to: action.effect.to });
        return true;
      }
      switch (action.effect.command) {
        case 'command-palette':
          useCommandPaletteStore.getState().toggle();
          return true;
        case 'open-settings':
          useSettingsDialog.getState().openSettings();
          return true;
        case 'open-hotkey-settings':
          useSettingsDialog.getState().openSettings('hotkeys');
          return true;
        case 'shortcuts-overlay':
          useShortcutsOverlay.getState().toggle();
          return true;
        case 'add-item':
          // The Add dialog is Inventory's local state with no route of its own, so arriving with
          // an intent is how every other entry point (palette, dashboard hero) opens it too.
          useInventoryEntry.getState().requestIntent('add');
          void navigate({ to: '/inventory' });
          return true;
        case 'start-scan':
          useInventoryEntry.getState().requestIntent('scan');
          void navigate({ to: '/inventory' });
          return true;
        case 'new-project':
          useHotkeyIntent.getState().request('new-project');
          void navigate({ to: '/projects' });
          return true;
        case 'new-purchase-order':
          useHotkeyIntent.getState().request('new-purchase-order');
          void navigate({ to: '/purchase-orders' });
          return true;
        case 'toggle-full-width': {
          const state = usePreferencesStore.getState();
          state.setFullWidth(!state.fullWidth);
          return true;
        }
        case 'toggle-theme': {
          const state = usePreferencesStore.getState();
          // `system` resolves to whichever the OS is currently showing, so the toggle always
          // moves to the *opposite* of what is on screen rather than to an arbitrary side.
          const showingDark =
            state.mode === 'dark' ||
            (state.mode === 'system' &&
              typeof window !== 'undefined' &&
              window.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
          state.setMode(showingDark ? 'light' : 'dark');
          return true;
        }
        case 'screen-new':
        case 'screen-search': {
          const handler = activeScopeHandler(action.effect.command);
          if (handler === undefined) return false;
          handler();
          return true;
        }
      }
    };

    const onKey = (event: globalThis.KeyboardEvent) => {
      // A modal owns the keyboard while it is open (see the module docstring).
      if (openModalCount() > 0) return;
      if (isTypingTarget(event.target as HTMLElement | null)) return;
      const chord = bindingFromEvent(event, IS_MAC);
      if (chord === null) return;

      const previous = pending.current;
      const step = stepHotkeySequence(previous, chord, resolved, isEnabled);
      disarm();

      if (step.kind === 'idle') return;
      if (step.kind === 'pending') {
        // Claim the prefix press and start the clock — an armed `G` must not also type a `g`.
        event.preventDefault();
        pending.current = step.prefix;
        expiry = setTimeout(disarm, SEQUENCE_TIMEOUT_MS);
        return;
      }
      // Only claim the press once the action has actually run; an unhandled contextual action
      // leaves the key to the browser.
      if (perform(step.action)) event.preventDefault();
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      disarm();
    };
  }, [enabled, bindings, paletteEnabled, enabledFeatures, navigate]);
}
