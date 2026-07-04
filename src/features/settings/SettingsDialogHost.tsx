import { lazy, Suspense } from 'react';
import { useSettingsDialog } from './useSettingsDialog';

/**
 * Lazy chunk boundary for the Settings dialog. Splitting it here means the whole
 * {@link SettingsDialog} control tree — and everything it pulls in (Danger zone, Database
 * maintenance, Storage triage) — is only fetched and parsed the first time the user opens
 * Settings, not on every app load. Settings is used mostly during onboarding and the
 * occasional tweak, so it should not sit in the critical path.
 */
const SettingsDialog = lazy(() => import('./SettingsDialog'));

/**
 * Mounts the app-wide Settings dialog. Rendered once from the root layout (inside the
 * router, so the dialog's links to Modules / About resolve), it watches the shared
 * {@link useSettingsDialog} switch and renders nothing at all until Settings is open —
 * so while closed there is no dialog subtree, no store subscriptions and no loaded chunk.
 */
export function SettingsDialogHost() {
  const open = useSettingsDialog((s) => s.open);
  const closeSettings = useSettingsDialog((s) => s.closeSettings);

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <SettingsDialog open onClose={closeSettings} />
    </Suspense>
  );
}
