import { Banner } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * Warns that some gauge contents are missing from the totals on screen because nothing prices
 * them (issue #683).
 *
 * A gauge tracks a *measure*, not a count of units, so it is valued as `contents × cost per unit
 * of measure` and never falls back to a per-unit price — `unit_cost`, a manual current value and
 * a supplier quote all price one countable unit, and applying one per gram would be wrong by
 * whatever the container's capacity happens to be. So a gauge with no cost per unit of measure
 * contributes nothing, and this says so.
 *
 * Its sibling {@link ForeignCurrencyNotice} exists for exactly the same reason and is worth
 * reading alongside: an exclusion nobody can see is its own kind of wrong answer, worst of all on
 * the insurance schedule, where the reader is a third party who cannot know stock is missing.
 * Before this, a full argon cylinder was reported as a confident £0 — indistinguishable from one
 * genuinely worth nothing. The remedy is named rather than implied: set the cost per unit of
 * measure.
 *
 * Renders nothing when `count` is 0 or still loading, so callers can mount it unconditionally.
 */
export function UnpricedGaugeNotice({
  count,
  className,
}: {
  /** Gauges whose contents are excluded — e.g. the value of `useUnpricedGaugeCount`. */
  count: number | undefined;
  className?: string;
}) {
  const t = useT();
  if (!count) return null;
  return (
    <Banner
      tone="warning"
      icon={<WarningIcon aria-hidden />}
      heading={t('reports.unpricedGauge.heading', { vars: { count } })}
      className={className}
      data-testid="unpriced-gauge-notice"
    >
      {t('reports.unpricedGauge.body', { vars: { count } })}
    </Banner>
  );
}
