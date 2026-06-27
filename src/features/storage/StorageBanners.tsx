import type { ReactNode } from 'react';
import { Banner, Button } from '@/components/foundry';
import { WarningIcon, CriticalIcon, StorageIcon, CloseIcon } from '@/components/icons';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { isLikelyMobile } from '@/lib/env/feature-detection';
import { formatBytes, formatPercent } from '@/lib/format';

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

  const mobile = isLikelyMobile();
  const percent = formatPercent(ratio);
  const usage = estimate ? formatBytes(estimate.usage) : '—';
  const quota = estimate ? formatBytes(estimate.quota) : '—';

  const banners: ReactNode[] = [];

  if (!persisted) {
    banners.push(
      <Banner
        key="persistence"
        tone={mobile ? 'warning' : 'info'}
        role="alert"
        icon={<StorageIcon />}
        heading="Your data may be cleared by the browser"
        action={
          <Button size="sm" variant="outline" onClick={() => void requestPersistence()}>
            Enable
          </Button>
        }
      >
        {mobile
          ? 'On mobile, add Gubbins to your Home Screen to keep your inventory safe from automatic eviction.'
          : 'Grant persistent storage so your inventory is not evicted when the device runs low on space.'}
      </Banner>,
    );
  }

  if (tier === 'locked') {
    banners.push(
      <Banner key="locked" tone="danger" role="alert" icon={<CriticalIcon />} heading="Storage full — saving paused">
        Gubbins has paused all writes to protect your data ({usage} of {quota}, {percent}). Delete items
        or export a backup to free space.
      </Banner>,
    );
  } else if (tier === 'critical') {
    banners.push(
      <Banner key="critical" tone="danger" role="alert" icon={<CriticalIcon />} heading="Storage critically full">
        {percent} of your local storage is used. New high-resolution image uploads are disabled until you
        free space.
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
          <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={dismissWarning}>
            <CloseIcon />
          </Button>
        }
      >
        {percent} of your local storage is used ({usage} of {quota}).
      </Banner>,
    );
  }

  if (banners.length === 0) return null;

  return <div className="flex flex-col gap-2">{banners}</div>;
}
