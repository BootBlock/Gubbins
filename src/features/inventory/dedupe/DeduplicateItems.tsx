/**
 * The **Deduplicate items** entry point (Settings → Inventory).
 *
 * A single Settings section that opens {@link DeduplicateItemsDialog} on demand, mirroring
 * Database maintenance. It lives in Settings rather than on a screen of its own because it is
 * upkeep the user reaches for occasionally, not a place they work — and because keeping it out
 * of the navigation is part of what makes it clear that **nothing here ever runs on its own**.
 *
 * The whole section answers to `items:delete`: everything the tool ends in is an item leaving
 * active inventory, so a role without that key is shown no section rather than a button whose
 * only outcome is a refusal.
 */
import { useState } from 'react';
import { Button } from '@/components/foundry';
import { MergeIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { SettingsSection, SettingRow } from '@/features/settings/SettingsSection';
import { usePermission } from '@/features/users/usePermission';
import { DeduplicateItemsDialog } from './DeduplicateItemsDialog';

export function DeduplicateItems() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const mayDelete = usePermission('items:delete');

  if (!mayDelete) return null;

  return (
    <>
      <SettingsSection id="deduplicate-items" icon={<MergeIcon />} title={t('inventory.dedupe.title')}>
        <SettingRow
          label={t('inventory.dedupe.row.label')}
          description={t('inventory.dedupe.row.description')}
          hintSize="md"
          hint={t('inventory.dedupe.row.hint')}
        >
          <Button variant="outline" data-testid="open-deduplicate-items" onClick={() => setOpen(true)}>
            <MergeIcon />
            {t('inventory.dedupe.row.action')}
          </Button>
        </SettingRow>
      </SettingsSection>

      {/* Mounted on demand so each open starts from a clean scan rather than a stale one. */}
      {open ? <DeduplicateItemsDialog open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
