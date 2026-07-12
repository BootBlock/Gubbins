/**
 * useSettingsDialog — the open/closed state of the app-wide Settings dialog.
 *
 * Settings is no longer a routed screen but a {@link RailModal} that opens over whatever
 * screen you are on (spec §3 preferences). That "open from anywhere" affordance needs a
 * single shared switch, so the global nav menu, the dashboard hub, the command palette and
 * the deep-link `/settings` redirect can all raise the same dialog without threading props
 * through the tree. The dialog's *contents* still write straight to `usePreferencesStore`,
 * so changes take effect in real time — this store only tracks whether the dialog is shown.
 *
 * A plain module-level store (no persistence): whether the dialog is open should never
 * survive a reload.
 */
import { create } from 'zustand';

interface SettingsDialogState {
  readonly open: boolean;
  /** Which rail tab to land on next time the dialog opens (undefined = default first tab). */
  readonly initialTab: string | undefined;
  /** Open the Settings dialog over the current screen, optionally jumping to a rail tab. */
  readonly openSettings: (tab?: string) => void;
  /** Close the Settings dialog. */
  readonly closeSettings: () => void;
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  initialTab: undefined,
  openSettings: (tab) => set({ open: true, initialTab: tab }),
  closeSettings: () => set({ open: false }),
}));
