import { createFileRoute, redirect } from '@tanstack/react-router';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';

/**
 * `/settings` is no longer a screen — Settings is a dialog that opens over the current
 * screen (see `SettingsDialogHost`). This route is kept purely as a **deep link**: a
 * bookmark, first-run link or shared URL to `/settings` opens the Settings dialog over the
 * Dashboard. The in-app entry points (global nav, dashboard hub, command palette) open the
 * dialog directly via {@link useSettingsDialog} instead of navigating here — so nothing
 * links to this route, and its `intent` preload can never fire the dialog prematurely.
 */
export const Route = createFileRoute('/settings')({
  beforeLoad: () => {
    useSettingsDialog.getState().openSettings();
    throw redirect({ to: '/' });
  },
});
