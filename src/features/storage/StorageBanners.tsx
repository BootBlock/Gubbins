import { type ReactNode, useState } from 'react';
import { Banner, Button, Tooltip, useInstallPrompt } from '@/components/foundry';
import { WarningIcon, CriticalIcon, StorageIcon, CloseIcon, DownloadIcon } from '@/components/icons';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { isLikelyMobile } from '@/lib/env/feature-detection';
import { useFormatters } from '@/lib/useFormatters';
import { isArchiveDue, runFullArchive } from '@/features/archive/auto-archive';
import { StorageTriageDialog } from './StorageTriageDialog';

/**
 * The persistent storage warning stack (spec §2, §7.6.1).
 *
 *  • Ephemeral-data warning when persistence was not granted — nudges Home Screen
 *    install (mobile eviction mitigation; Cloud Sync arrives in Phase 7).
 *  • Tiered quota degradation banners: dismissible at 80%, persistent at 90%, and
 *    a Hard-Stop notice at 95%.
 */
export function StorageBanners() {
  const persisted = useStorageStore((state) => state.persisted);
  const tier = useStorageStore((state) => state.tier);
  const estimate = useStorageStore((state) => state.estimate);
  const ratio = useStorageStore((state) => state.ratio);
  const warningDismissed = useStorageStore((state) => state.warningDismissed);
  const dismissWarning = useStorageStore((state) => state.dismissWarning);
  const requestPersistence = useStorageStore((state) => state.requestPersistence);

  const providerId = useAuthStore((state) => state.providerId);
  const lastArchivedAt = usePreferencesStore((state) => state.lastArchivedAt);
  const setLastArchivedAt = usePreferencesStore((state) => state.setLastArchivedAt);

  const [triageOpen, setTriageOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fmt = useFormatters();
  const { canInstall, promptInstall } = useInstallPrompt();

  async function archiveNow() {
    setArchiving(true);
    try {
      await runFullArchive();
      setLastArchivedAt(Date.now());
    } catch (err) {
      console.error('[gubbins] full archive failed', err);
    } finally {
      setArchiving(false);
    }
  }
  /** §7.6.2: the user is directed to the Triage Dashboard from critical/locked. */
  const manageStorage = (
    <Tooltip
      content="Open Storage Triage to see what's using space and reclaim it — purge old history or downgrade old images."
      triggerTabIndex={-1}
    >
      <span>
        <Button
          size="sm"
          variant="outline"
          data-testid="open-storage-triage"
          onClick={() => setTriageOpen(true)}
        >
          Manage storage
        </Button>
      </span>
    </Tooltip>
  );

  const mobile = isLikelyMobile();
  const percent = fmt.percent(ratio);
  const usage = estimate ? fmt.bytes(estimate.usage) : '—';
  const quota = estimate ? fmt.bytes(estimate.quota) : '—';

  const banners: ReactNode[] = [];

  // §2.7: mobile users without active Cloud Sync (where File System Access auto-save is
  // unavailable) get a weekly nudge to download a full archive (SQLite binary + images).
  if (mobile && providerId === null && isArchiveDue(lastArchivedAt, Date.now())) {
    banners.push(
      <Banner
        key="archive"
        tone="info"
        role="alert"
        icon={<DownloadIcon />}
        heading="Time for a weekly backup"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void archiveNow()}
            disabled={archiving}
            data-testid="run-archive"
          >
            {archiving ? 'Preparing…' : 'Download archive'}
          </Button>
        }
      >
        Without Cloud Sync, download a full archive (database + images) so a browser clear-out can&apos;t lose
        your inventory.
      </Banner>,
    );
  }

  if (!persisted) {
    banners.push(
      <Banner
        key="persistence"
        tone={mobile ? 'warning' : 'info'}
        role="alert"
        icon={<StorageIcon />}
        heading="Your data may be cleared by the browser"
        action={
          <div className="flex items-center gap-2">
            {/* Installing the PWA is the most reliable route to persistent storage,
                so offer it as the primary action where the platform supports it. */}
            {canInstall ? (
              <Button size="sm" data-testid="install-app-banner" onClick={() => void promptInstall()}>
                Install Gubbins
              </Button>
            ) : null}
            <Tooltip
              content="Ask the browser for persistent storage, so it won't evict your inventory when the device is low on space."
              triggerTabIndex={-1}
            >
              <span>
                <Button size="sm" variant="outline" onClick={() => void requestPersistence()}>
                  Enable
                </Button>
              </span>
            </Tooltip>
          </div>
        }
      >
        {canInstall
          ? 'Install Gubbins as an app so the browser keeps your inventory safe from automatic eviction.'
          : mobile
            ? 'On mobile, add Gubbins to your Home Screen to keep your inventory safe from automatic eviction.'
            : 'Grant persistent storage so your inventory is not evicted when the device runs low on space.'}
      </Banner>,
    );
  }

  if (tier === 'locked') {
    banners.push(
      <Banner
        key="locked"
        tone="danger"
        role="alert"
        icon={<CriticalIcon />}
        heading="Storage full — saving paused"
        action={manageStorage}
      >
        Gubbins has paused all writes to protect your data ({usage} of {quota}, {percent}). Reclaim space to
        continue.
      </Banner>,
    );
  } else if (tier === 'critical') {
    banners.push(
      <Banner
        key="critical"
        tone="danger"
        role="alert"
        icon={<CriticalIcon />}
        heading="Storage critically full"
        action={manageStorage}
      >
        {percent} of your local storage is used. New high-resolution image uploads are disabled until you free
        space.
      </Banner>,
    );
  } else if (tier === 'warning' && !warningDismissed) {
    banners.push(
      <Banner
        key="warning"
        tone="warning"
        icon={<WarningIcon />}
        heading="Storage is filling up"
        action={
          <Tooltip content="Hide this warning until storage fills further." triggerTabIndex={-1}>
            <span>
              <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={dismissWarning}>
                <CloseIcon className="text-glyph-neutral" />
              </Button>
            </span>
          </Tooltip>
        }
      >
        {percent} of your local storage is used ({usage} of {quota}).
      </Banner>,
    );
  }

  return (
    <>
      {banners.length > 0 ? <div className="flex flex-col gap-2">{banners}</div> : null}
      {/* Mounted only while open (independent of tier) so its reads run on demand and
          its reference "now" is captured at open time, not at app boot. */}
      {triageOpen ? <StorageTriageDialog open onClose={() => setTriageOpen(false)} /> : null}
    </>
  );
}
