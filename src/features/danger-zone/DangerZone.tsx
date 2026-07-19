/**
 * Danger Zone settings section (§3).
 *
 * Renders a single settings section that opens the `EraseDataDialog` on demand.
 * Uses the shared `SettingsSection` and `SettingRow` helpers so the visual appearance
 * is consistent with the rest of the settings.
 *
 * The Settings dialog gives this its own tinted rail tab at the very foot of the rail —
 * set apart from the ordinary sections above it — where destructive actions
 * conventionally live.
 */
import { useState } from 'react';
import { Button } from '@/components/foundry';
import { CriticalIcon, RefreshIcon } from '@/components/icons';
import { resetServiceWorkerOnly } from '@/app/error/safe-mode-actions';
import { useT } from '@/features/i18n';
import { SettingsSection, SettingRow } from '@/features/settings/SettingsSection';
import { EraseDataDialog } from './EraseDataDialog';

export function DangerZone() {
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const t = useT();

  return (
    <>
      <SettingsSection id="danger-zone" icon={<CriticalIcon />} title="Danger zone">
        {/*
         * First, and deliberately *not* destructive (issue #276). When a bad build is what
         * went wrong, this fixes it while keeping every byte of the user's data — so a
         * cosmetic bug never pushes anyone towards the erase button below it.
         */}
        <SettingRow
          label={t('settings.appShellReset.label')}
          description={t('settings.appShellReset.description')}
        >
          <Button
            variant="outline"
            data-testid="reset-app-shell"
            disabled={resetting}
            onClick={() => {
              setResetting(true);
              // Resolves by navigating away; a failure inside is already swallowed
              // per-step, so there is nothing to surface but the re-enabled button.
              void resetServiceWorkerOnly().finally(() => setResetting(false));
            }}
          >
            <RefreshIcon />
            {t('settings.appShellReset.action')}
          </Button>
        </SettingRow>

        <SettingRow
          label="Erase data"
          description="Selectively wipe inventory, photos, settings, sign-in or sync links from this device — or factory-reset everything."
        >
          <Button variant="destructive" data-testid="open-erase-data" onClick={() => setOpen(true)}>
            <CriticalIcon />
            Erase data&hellip;
          </Button>
        </SettingRow>
      </SettingsSection>

      {/* Mounted on demand so counts are fetched fresh each time it opens. */}
      {open ? <EraseDataDialog open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
