import { useId, useState } from 'react';
import { AnimatedNumber, Money, SegmentedRadioGroup, Spinner, Surface } from '@/components/foundry';
import { DiscreteIcon, PackageIcon, ValueIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useLocationStats } from '@/features/reports/queries';
import { ValueBreakdown } from '@/features/reports/components/ValueBreakdown';
import { useFormatters } from '@/lib/useFormatters';

type Scope = 'self' | 'subtree';

/**
 * The **Statistics** tab of {@link EditLocationDialog} (issue #458): read-only, in-depth aggregate
 * information derived from the items a location holds — the combined value of everything stored
 * here, how many distinct items and units that is, and where that value sits by category.
 *
 * The figures come from {@link useLocationStats}, which reads the per-location `item_stock` ledger
 * valued by the same rule as the Reports "value by location" breakdown, so a location's value here
 * always agrees with its row there. When the location has sub-locations, a scope toggle rolls the
 * figures up its whole subtree ("the Garage" including every shelf beneath it).
 */
export function LocationStats({
  locationId,
  hasChildren,
}: {
  locationId: string;
  /** Whether the location has sub-locations — gates the "with sub-locations" scope toggle. */
  hasChildren: boolean;
}) {
  const t = useT();
  const fmt = useFormatters();
  const scopeLabelId = useId();
  const [scope, setScope] = useState<Scope>('self');
  const stats = useLocationStats(locationId, hasChildren && scope === 'subtree');

  const scopeOptions = [
    { value: 'self' as const, label: t('inventory.locationStats.scopeSelf') },
    { value: 'subtree' as const, label: t('inventory.locationStats.scopeSubtree') },
  ];

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
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatTile
              icon={<ValueIcon />}
              label={t('inventory.locationStats.totalValue')}
              value={<Money value={stats.data.totalValue} formatters={fmt} animate />}
              testId="location-stats-value"
            />
            <StatTile
              icon={<PackageIcon />}
              label={t('inventory.locationStats.items')}
              value={<AnimatedNumber value={stats.data.distinctItemCount} format={fmt.quantity} />}
              testId="location-stats-items"
            />
            <StatTile
              icon={<DiscreteIcon />}
              label={t('inventory.locationStats.units')}
              value={<AnimatedNumber value={stats.data.totalQuantity} format={fmt.quantity} />}
              testId="location-stats-units"
            />
          </div>

          {stats.data.unpricedItemCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('inventory.locationStats.unpriced', {
                vars: { count: stats.data.unpricedItemCount },
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
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
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
    </Surface>
  );
}
