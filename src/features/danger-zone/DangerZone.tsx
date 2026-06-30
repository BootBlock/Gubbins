/**
 * Danger Zone settings section (§3).
 *
 * Renders a single settings section that opens the `EraseDataDialog` on demand.
 * Uses the exported `SettingsSection` and `SettingRow` helpers from the Settings
 * screen so the visual appearance is consistent with the rest of the settings page.
 *
 * Mount this as the LAST section in `SettingsScreen` so the Danger Zone sits at
 * the bottom — below About — where destructive actions conventionally live.
 */
import { useState } from 'react';
import { Button } from '@/components/foundry';
import { CriticalIcon } from '@/components/icons';
import { SettingsSection, SettingRow } from '@/features/settings/SettingsSection';
import { EraseDataDialog } from './EraseDataDialog';

export function DangerZone() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsSection id="danger-zone" icon={<CriticalIcon />} title="Danger zone">
        <SettingRow
          label="Erase data"
          description="Selectively wipe inventory, photos, settings, sign-in or sync links from this device — or factory-reset everything."
        >
          <Button
            variant="destructive"
            data-testid="open-erase-data"
            onClick={() => setOpen(true)}
          >
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
