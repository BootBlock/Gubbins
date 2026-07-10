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
import { WarningIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useT } from '@/features/i18n';

/**
 * Master switch for the pre-1.0 work-in-progress banner. Set to `false` once Gubbins
 * reaches its 1.0 release and backwards compatibility is guaranteed.
 */
export const SHOW_WIP_BANNER = true;

export function DashboardBanner({ className }: { readonly className?: string }) {
  const t = useT();
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
        aria-label={t('dashboard.wipBanner.ariaLabel')}
        data-testid="dashboard-wip-banner"
        icon={<WarningIcon aria-hidden className="text-warning" />}
        heading={t('dashboard.wipBanner.heading')}
        className={className}
        onDismiss={() => setConfirmOpen(true)}
        dismissLabel={t('dashboard.wipBanner.dismissLabel')}
        dismissTestId="wip-banner-dismiss"
      >
        {t('dashboard.wipBanner.body')}
      </Banner>

      {confirmOpen ? (
        <Modal open onClose={() => setConfirmOpen(false)} title={t('dashboard.wipBanner.confirmTitle')}>
          <p className="text-sm text-muted-foreground">
            {t('dashboard.wipBanner.confirmBody.pre')}{' '}
            <strong className="font-semibold text-foreground">
              {t('dashboard.wipBanner.confirmBody.emphasis')}
            </strong>
            .
          </p>
          <p className="mt-3 text-sm text-muted-foreground">{t('dashboard.wipBanner.confirmNote')}</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('dashboard.wipBanner.keep')}
            </Button>
            <Button onClick={confirmDismiss} data-testid="wip-banner-confirm-dismiss">
              {t('dashboard.wipBanner.confirm')}
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
