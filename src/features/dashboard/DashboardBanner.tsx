/**
 * DashboardBanner — a pre-1.0 "work in progress" warning shown in the dashboard hero,
 * immediately to the left of the version/date. Gated behind {@link SHOW_WIP_BANNER}: flip
 * the flag to `false` (e.g. at the 1.0 release) to remove the banner entirely.
 */
import { Banner } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';

/**
 * Master switch for the pre-1.0 work-in-progress banner. Set to `false` once Gubbins
 * reaches its 1.0 release and backwards compatibility is guaranteed.
 */
export const SHOW_WIP_BANNER = true;

export function DashboardBanner() {
  if (!SHOW_WIP_BANNER) return null;

  return (
    <Banner
      tone="warning"
      role="note"
      aria-label="Pre-release warning"
      data-testid="dashboard-wip-banner"
      icon={<WarningIcon aria-hidden className="text-warning" />}
      heading="Work in progress"
      className="max-w-md px-3 py-2 text-xs"
    >
      Updates may not be backwards compatible, so data loss is expected. Backwards compatibility will be
      maintained once Gubbins reaches its 1.0 release.
    </Banner>
  );
}
