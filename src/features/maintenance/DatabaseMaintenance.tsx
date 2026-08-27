/**
 * Database Maintenance settings section.
 *
 * A single Settings section (mirroring the Danger Zone) that opens the
 * {@link DatabaseMaintenanceDialog} on demand. Sits above the Danger Zone: routine,
 * non-destructive upkeep, kept apart from the irreversible erase actions below it.
 *
 * The upkeep it offers rewrites the database file and deletes orphaned photo files from this
 * device, so the whole section answers to `storage:write` (issue #429). A role without it is
 * shown no section at all rather than a button whose only outcome is a refusal.
 */
import { useState } from 'react';
import { Button } from '@/components/foundry';
import { DatabaseIcon } from '@/components/icons';
import { SettingsSection, SettingRow } from '@/features/settings/SettingsSection';
import { usePermission } from '@/features/users/usePermission';
import { DatabaseMaintenanceDialog } from './DatabaseMaintenanceDialog';

export function DatabaseMaintenance() {
  const [open, setOpen] = useState(false);
  const mayWrite = usePermission('storage:write');

  if (!mayWrite) return null;

  return (
    <>
      <SettingsSection id="database-maintenance" icon={<DatabaseIcon />} title="Database maintenance">
        <SettingRow
          label="Maintain database"
          description="Compact and optimise the local database, check its health, and remove orphaned photo files. None of these remove your inventory."
        >
          <Button variant="outline" data-testid="open-database-maintenance" onClick={() => setOpen(true)}>
            <DatabaseIcon />
            Maintain&hellip;
          </Button>
        </SettingRow>
      </SettingsSection>

      {/* Mounted on demand so its ports (and stable state) are created fresh each open. */}
      {open ? <DatabaseMaintenanceDialog open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
