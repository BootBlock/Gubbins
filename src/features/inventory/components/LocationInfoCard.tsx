import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/components/foundry';
import { CycleCountIcon, HideIcon, HistoryIcon, MoveIcon, PackageIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useFeature } from '@/features/modules/useFeature';
import { locationPath } from '../location-tree';
import { useLocationFullness } from '../use-location-fullness';
import { locationColorTextClass } from '../location-color';
import { LocationIcon } from './LocationIcon';
import { LocationFullnessBar } from './LocationFullnessBar';
import { describeVolumetricFullness } from './volumetric-fullness-text';

/**
 * A vertically compact, single-row summary of the selected location, shown atop the
 * inventory list. It surfaces the same headline facts as the Edit-location dialog — the
 * capacity/fullness gauge, item count, breadcrumb path, sub-locations and last change —
 * without leaving the workspace.
 *
 * The row never wraps: as the viewport narrows it sheds its least-useful pieces first
 * (sub-locations at `xl`, "updated" at `lg`, the fullness bar at `sm`, the path at
 * `md`), always keeping the identity and item count. The whole card is opt-out — the user
 * dismisses it from here or the inventory "More" menu, and the choice persists (see
 * {@link useLayoutStore.inventoryLocationCard}).
 */
export function LocationInfoCard({
  location,
  locations,
  onHide,
}: {
  /** The selected location, with its live item count. */
  location: LocationWithCount;
  /** All locations (flat) — for resolving the breadcrumb path and sub-location count. */
  locations: readonly LocationWithCount[];
  /** Dismiss the card (persists the preference off). */
  onHide: () => void;
}) {
  const fmt = useFormatters();
  // "Last counted" only means something while stock-taking is on offer: with the `cycle-counts`
  // module off the stamp can never move, so the stat sheds with the entry points that set it.
  const cycleCountsEnabled = useFeature('cycle-counts');
  const path = useMemo(() => locationPath(location.id, locations), [location.id, locations]);
  const childCount = useMemo(
    () => locations.filter((l) => l.parentId === location.id).length,
    [locations, location.id],
  );
  // Volumetric fullness when the location has a measured size (issue #457), else the count gauge.
  const fullness = useLocationFullness(location);
  // A plain-text volume/coverage summary for the sr-only label + hover title (the row is too
  // narrow for a visible caption — the Edit dialog shows the full caption).
  const fullnessDetail = fullness ? describeVolumetricFullness(fullness, fmt) : null;
  const colorClass = locationColorTextClass(location.color);
  // A root location's path is just its own name — no point repeating it beside the name.
  const showPath = path.length > 0 && path !== location.name;
  const itemsValue =
    location.capacity != null && location.capacity > 0
      ? `${fmt.quantity(location.itemCount)} / ${fmt.quantity(location.capacity)}`
      : fmt.quantity(location.itemCount);

  return (
    <section
      aria-label={`Summary of ${location.name}`}
      data-testid="location-info-card"
      className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <LocationIcon icon={location.icon} className={cn('size-5 shrink-0', colorClass)} />

      <div className="flex min-w-0 items-baseline gap-2">
        <span className={cn('truncate font-medium', colorClass)} title={location.name}>
          {location.name}
        </span>
        {showPath ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground md:inline" title={path}>
            {path}
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-4 text-sm">
        <Stat icon={<PackageIcon aria-hidden />} label="Items" value={itemsValue} />

        {fullness ? (
          <div
            className="hidden w-28 items-center sm:flex"
            data-testid="location-info-fullness"
            title={fullnessDetail ?? undefined}
          >
            <span className="sr-only">{fullnessDetail ? `Fullness: ${fullnessDetail}` : 'Fullness'}</span>
            <LocationFullnessBar fullness={fullness} className="flex-1" />
          </div>
        ) : null}

        <div className="hidden lg:block">
          <Stat
            icon={<HistoryIcon aria-hidden />}
            label="Updated"
            value={fmt.relativeTime(location.updatedAt)}
            title={fmt.dateTime(location.updatedAt)}
          />
        </div>

        {cycleCountsEnabled ? (
          <div className="hidden xl:block" data-testid="location-info-last-counted">
            <Stat
              icon={<CycleCountIcon aria-hidden />}
              label="Last counted"
              value={location.lastCountedAt != null ? fmt.relativeTime(location.lastCountedAt) : 'Never'}
              title={location.lastCountedAt != null ? fmt.dateTime(location.lastCountedAt) : undefined}
            />
          </div>
        ) : null}

        {childCount > 0 ? (
          <div className="hidden xl:block">
            <Stat icon={<MoveIcon aria-hidden />} label="Sub-locations" value={fmt.quantity(childCount)} />
          </div>
        ) : null}
      </div>

      <Tooltip content="Hide this summary. Bring it back from the More menu." triggerTabIndex={-1}>
        <span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onHide}
            aria-label="Hide location summary"
            data-testid="location-info-hide"
          >
            <HideIcon />
          </Button>
        </span>
      </Tooltip>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  title,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <span className="flex items-center gap-1 text-xs leading-none text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums leading-none">{value}</span>
    </div>
  );
}
