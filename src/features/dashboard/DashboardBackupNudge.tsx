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
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Button, Surface, buttonVariants } from '@/components/foundry';
import { CloudUploadIcon, SecureIcon, CloseIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useItemCount } from '@/features/inventory/queries';

export function DashboardBackupNudge({ className }: { readonly className?: string }) {
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
    <Surface className={cn('flex flex-col gap-4 p-5', className)} data-testid="dashboard-backup-nudge">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-primary [&_svg]:size-5">
          <SecureIcon aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Keep your inventory safe</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gubbins stores everything privately in this browser. Set up Cloud Sync or take a backup so a
            browser clear-out, a lost device, or a new browser can&apos;t lose your inventory.
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={dismiss}
          aria-label="Dismiss"
          data-testid="backup-nudge-dismiss"
          className="-mr-1 -mt-1 shrink-0"
        >
          <CloseIcon className="text-glyph-neutral" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/sync"
          className={cn(buttonVariants({ variant: 'primary' }))}
          data-testid="backup-nudge-open"
        >
          <CloudUploadIcon />
          Set up sync &amp; backup
        </Link>
      </div>
    </Surface>
  );
}
