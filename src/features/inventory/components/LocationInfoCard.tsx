import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/components/foundry';
import { HideIcon, HistoryIcon, MoveIcon, PackageIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { locationPath } from '../location-tree';
import { locationFullness } from '../location-fullness';
import { locationColorTextClass } from '../location-color';
import { locationKindLabel } from '../location-kind';
import { LocationKindIcon } from './LocationKindIcon';
import { LocationFullnessBar } from './LocationFullnessBar';

/**
 * A vertically compact, single-row summary of the selected location, shown atop the
 * inventory list. It surfaces the same headline facts as the Edit-location dialog — the
 * capacity/fullness gauge, item count, breadcrumb path, sub-locations and last change —
 * without leaving the workspace.
 *
 * The row never wraps: as the viewport narrows it sheds its least-useful pieces first
 * (type + sub-locations at `xl`, "updated" at `lg`, the fullness bar at `sm`, the path at
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
  const path = useMemo(() => locationPath(location.id, locations), [location.id, locations]);
  const childCount = useMemo(
    () => locations.filter((l) => l.parentId === location.id).length,
    [locations, location.id],
  );
  const fullness = locationFullness(location.itemCount, location.capacity);
  const kindLabel = locationKindLabel(location.kind);
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
      <LocationKindIcon kind={location.kind} className={cn('size-5 shrink-0', colorClass)} />

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
          <div className="hidden w-28 items-center sm:flex" data-testid="location-info-fullness">
            <span className="sr-only">Fullness</span>
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

        {childCount > 0 ? (
          <div className="hidden xl:block">
            <Stat icon={<MoveIcon aria-hidden />} label="Sub-locations" value={fmt.quantity(childCount)} />
          </div>
        ) : null}

        {kindLabel ? (
          <div className="hidden xl:block">
            <Stat label="Type" value={kindLabel} />
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
