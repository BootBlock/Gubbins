/**
 * DashboardBanner — a pre-1.0 "work in progress" warning shown on the dashboard, beside the
 * "Keep your inventory safe" backup nudge. Gated behind {@link SHOW_WIP_BANNER}: flip the flag
 * to `false` (e.g. at the 1.0 release) to remove the banner entirely.
 *
 * The banner carries a close button so a user who has taken the warning on board can dismiss
 * it. Because dismissing hides a genuine data-loss risk, the close first opens a confirmation
 * that makes the user acknowledge data can still be lost until 1.0 is officially released; only
 * then is the dismissal persisted (`wipBannerDismissed`).
 */
import { useState } from 'react';
import { Banner, Button, Modal } from '@/components/foundry';
import { CloseIcon, WarningIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * Master switch for the pre-1.0 work-in-progress banner. Set to `false` once Gubbins
 * reaches its 1.0 release and backwards compatibility is guaranteed.
 */
export const SHOW_WIP_BANNER = true;

export function DashboardBanner({ className }: { readonly className?: string }) {
  const dismissed = usePreferencesStore((s) => s.wipBannerDismissed);
  const dismiss = usePreferencesStore((s) => s.dismissWipBanner);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!SHOW_WIP_BANNER || dismissed) return null;

  const confirmDismiss = () => {
    dismiss();
    setConfirmOpen(false);
  };

  return (
    <>
      <Banner
        tone="warning"
        role="note"
        aria-label="Pre-release warning"
        data-testid="dashboard-wip-banner"
        icon={<WarningIcon aria-hidden className="text-warning" />}
        heading="Work in progress"
        className={className}
        action={
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setConfirmOpen(true)}
            aria-label="Dismiss the work-in-progress warning"
            data-testid="wip-banner-dismiss"
            // Ghost's default hover (`bg-secondary/60`) is a neutral grey-blue that reads as
            // borrowing a different surface's colour on this warning-toned banner. Tint it to
            // the banner's own tone instead (matching the `hover:bg-warning/25` convention used
            // elsewhere for a warning-surface dismiss control, e.g. CapabilityEditor's tag chip).
            className="-mr-1 -mt-1 shrink-0 hover:bg-warning/25"
          >
            <CloseIcon className="text-glyph-neutral" />
          </Button>
        }
      >
        Updates may not be backwards compatible, so data loss is expected. Backwards compatibility will be
        maintained once Gubbins reaches its 1.0 release.
      </Banner>

      {confirmOpen ? (
        <Modal open onClose={() => setConfirmOpen(false)} title="Dismiss the pre-release warning?">
          <p className="text-sm text-muted-foreground">
            Gubbins is still pre-release. Until version 1.0 is officially released, an update may not be
            backwards compatible and{' '}
            <strong className="font-semibold text-foreground">you can lose your data</strong>.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Hiding this warning does not remove that risk — please keep your own backups until 1.0 lands.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep the warning
            </Button>
            <Button onClick={confirmDismiss} data-testid="wip-banner-confirm-dismiss">
              I understand — dismiss
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
