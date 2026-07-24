import { useId, useState } from 'react';
import { AnimatedNumber, Money, SegmentedRadioGroup, Spinner, Surface } from '@/components/foundry';
import { DiscreteIcon, LocationBoxIcon, PackageIcon, ValueIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useLocationStats } from '@/features/reports/queries';
import { ValueBreakdown } from '@/features/reports/components/ValueBreakdown';
import { useFormatters } from '@/lib/useFormatters';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { locationCapacityVolume } from '../location-fullness';

type Scope = 'self' | 'subtree';

/**
 * The **Statistics** tab of {@link EditLocationDialog} (issue #458): read-only, in-depth aggregate
 * information derived from the items a location holds — the combined value of everything stored
 * here, how many distinct items and units that is, the physical space it occupies, and where that
 * value sits by category.
 *
 * The figures come from {@link useLocationStats}, which reads the per-location `item_stock` ledger
 * valued by the same rule as the Reports "value by location" breakdown, so a location's value here
 * always agrees with its row there. **Space used** sums each item's bounding-box volume × the units
 * held (issue #457), matching the location tree's volume bar; when the location has a measured
 * internal size, it also shows how full it is against that volume capacity. When the location has
 * sub-locations, a scope toggle rolls the figures up its whole subtree ("the Garage" including
 * every shelf beneath it).
 */
export function LocationStats({
  location,
  hasChildren,
}: {
  /** The location whose contents are summarised (its volume capacity drives the utilisation note). */
  location: LocationWithCount;
  /** Whether the location has sub-locations — gates the "with sub-locations" scope toggle. */
  hasChildren: boolean;
}) {
  const t = useT();
  const fmt = useFormatters();
  const scopeLabelId = useId();
  const [scope, setScope] = useState<Scope>('self');
  const packingFactor = usePreferencesStore((s) => s.defaultPackingFactor);
  const stats = useLocationStats(location.id, hasChildren && scope === 'subtree');

  const scopeOptions = [
    { value: 'self' as const, label: t('inventory.locationStats.scopeSelf') },
    { value: 'subtree' as const, label: t('inventory.locationStats.scopeSubtree') },
  ];

  // The location's derived usable volume (mm³), or null when it has no measured internal size.
  // Utilisation is shown for the location's own contents only (a subtree has no single capacity),
  // and — crucially — divides the *same* `usedVolume` the tile shows by this capacity, so the
  // percentage can never disagree with the figure above it.
  const capacityVolume = locationCapacityVolume(location, packingFactor);

  return (
    <div className="space-y-4" data-testid="location-stats">
      {hasChildren ? (
        <div className="relative">
          <span id={scopeLabelId} className="mb-field-gap block text-sm font-medium">
            {t('inventory.locationStats.scopeLabel')}
          </span>
          <SegmentedRadioGroup
            options={scopeOptions}
            value={scope}
            onChange={setScope}
            labelledBy={scopeLabelId}
            testIdPrefix="location-stats-scope"
          />
        </div>
      ) : null}

      {stats.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : stats.isError || !stats.data ? (
        <p role="alert" className="py-6 text-center text-sm text-destructive">
          {t('inventory.locationStats.error')}
        </p>
      ) : stats.data.distinctItemCount === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t('inventory.locationStats.empty')}
        </p>
      ) : (
        (() => {
          const { totalValue, distinctItemCount, totalQuantity, unpricedItemCount } = stats.data;
          const { usedVolume, measuredItemCount } = stats.data;
          const hasVolume = measuredItemCount > 0;
          // Lock the used figure and the capacity note to one unit so they read as a pair.
          const volUnit = fmt.volumeUnitFor(Math.max(usedVolume, capacityVolume ?? 0));
          const spaceUsed = hasVolume ? fmt.volume(usedVolume, volUnit) : '—';
          const unmeasured = distinctItemCount - measuredItemCount;

          // Utilisation against the location's own capacity — self-scope only, from the same
          // `usedVolume` shown above (never a second data source), clamped 0–100 like the tree bar.
          let volumeUtil: string | undefined;
          if (hasVolume && scope === 'self' && capacityVolume != null && capacityVolume > 0) {
            const percent = Math.min(100, Math.max(0, Math.round((usedVolume / capacityVolume) * 100)));
            volumeUtil = t('inventory.locationStats.volumeUtil', {
              vars: { percent, capacity: fmt.volume(capacityVolume, volUnit) },
            });
          }

          return (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  icon={<ValueIcon />}
                  label={t('inventory.locationStats.totalValue')}
                  value={<Money value={totalValue} formatters={fmt} animate />}
                  testId="location-stats-value"
                />
                <StatTile
                  icon={<PackageIcon />}
                  label={t('inventory.locationStats.items')}
                  value={<AnimatedNumber value={distinctItemCount} format={fmt.quantity} />}
                  testId="location-stats-items"
                />
                <StatTile
                  icon={<DiscreteIcon />}
                  label={t('inventory.locationStats.units')}
                  value={<AnimatedNumber value={totalQuantity} format={fmt.quantity} />}
                  testId="location-stats-units"
                />
                <StatTile
                  icon={<LocationBoxIcon />}
                  label={t('inventory.locationStats.spaceUsed')}
                  value={spaceUsed}
                  sub={volumeUtil}
                  testId="location-stats-volume"
                />
              </div>

              {unpricedItemCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('inventory.locationStats.unpriced', { vars: { count: unpricedItemCount } })}
                </p>
              ) : null}

              {unmeasured > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="location-stats-unmeasured">
                  {t('inventory.locationStats.unmeasured', {
                    vars: { measured: measuredItemCount, total: distinctItemCount },
                  })}
                </p>
              ) : null}

              <div className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('inventory.locationStats.byCategory')}
                </h3>
                <ValueBreakdown
                  groups={stats.data.byCategory}
                  formatters={fmt}
                  emptyLabel={t('inventory.locationStats.empty')}
                />
              </div>
            </>
          );
        })()
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  sub,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Surface className="flex h-full flex-col gap-1 p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <span className="text-xl font-semibold tracking-tight tabular-nums" data-testid={testId}>
        {value}
      </span>
      {sub ? <span className="text-xs text-muted-foreground tabular-nums">{sub}</span> : null}
    </Surface>
  );
}
