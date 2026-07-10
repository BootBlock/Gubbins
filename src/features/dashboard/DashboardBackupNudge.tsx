/**
 * DashboardBackupNudge — a gentle, one-time prompt to protect your data.
 *
 * Gubbins is local-first: everything lives in this browser profile until the user sets up
 * Cloud Sync or takes a backup. Granting persistent storage (the app-wide storage banner)
 * stops the browser *evicting* data, but it does nothing for a cleared profile, a lost
 * device, or a browser switch — only sync/backup does. This nudge closes that gap: it appears
 * on the dashboard once there is actually data worth protecting and no sync provider is
 * connected, and points at the Cloud Sync & backups screen.
 *
 * It is deliberately quiet: it self-hides once any sync provider is connected, is dismissible
 * for good, and never shows on an empty database (there the first-run
 * {@link DashboardGettingStarted} panel owns the space, and there is nothing to lose yet).
 *
 * Built on the shared {@link Banner} control (tone `info`, matching its primary-tinted icon)
 * rather than a hand-rolled card, so it pairs pixel-consistently with the "Work in progress"
 * banner beside it — same close-button position, same tone-matched hover.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Banner, buttonVariants } from '@/components/foundry';
import { CloudUploadIcon, SecureIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useItemCount } from '@/features/inventory/queries';
import { useT } from '@/features/i18n';

export function DashboardBackupNudge({ className }: { readonly className?: string }) {
  const t = useT();
  const dismissed = usePreferencesStore((s) => s.backupNudgeDismissed);
  const dismiss = usePreferencesStore((s) => s.dismissBackupNudge);
  const providerId = useAuthStore((s) => s.providerId);
  // Count every item (incl. inactive) so the nudge tracks "is there anything to protect",
  // matching how the first-run panel decides the database is non-empty.
  const count = useItemCount({ includeInactive: true });

  // Hide when: dismissed, a sync provider is already connected, the count is still loading
  // (no flash), or the inventory is empty (nothing to lose yet — the getting-started panel shows).
  if (dismissed || providerId !== null || count.isPending || (count.data ?? 0) === 0) return null;

  return (
    <Banner
      tone="info"
      icon={<SecureIcon aria-hidden className="text-primary" />}
      heading={t('dashboard.backupNudge.heading')}
      className={className}
      data-testid="dashboard-backup-nudge"
      onDismiss={dismiss}
      dismissLabel={t('dashboard.backupNudge.dismiss')}
      dismissTestId="backup-nudge-dismiss"
    >
      <p>{t('dashboard.backupNudge.body')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          to="/sync"
          className={cn(buttonVariants({ variant: 'primary' }))}
          data-testid="backup-nudge-open"
        >
          <CloudUploadIcon />
          {t('dashboard.backupNudge.action')}
        </Link>
      </div>
    </Banner>
  );
}
