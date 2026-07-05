import type { ComponentType } from 'react';
import { Button, Tooltip } from '@/components/foundry';
import {
  CheckoutIcon,
  DueDateIcon,
  ExpiryIcon,
  FilterIcon,
  LowStockIcon,
  MaintenanceIcon,
  OutOfStockIcon,
  WarrantyIcon,
} from '@/components/icons';
import { ITEM_STATUS_FILTERS, STATUS_FILTER_FEATURE, type ItemStatusFilter } from '@/db/repositories';
import { useEnabledFeatures } from '@/features/modules/useFeature';

/**
 * The inventory **status filter** bar (spec §3 / §4): a row of toggle chips for the common
 * "needs attention" filters — Low stock, Expiring, Overdue, Maintenance due. Selecting one
 * or more narrows the list to items matching *any* chosen concern (OR-combined server-side
 * via {@link buildStatusFilter}); the chips are additive to the location scope and search.
 *
 * A chip is only shown when its underlying capability is enabled (Modular UI, §4): Expiring
 * needs `perishables`, Warranty needs `warranty`, On loan / Overdue need `contacts` (the
 * borrow/loan facet), Maintenance due needs `maintenance`. Low stock and Out of stock are
 * core inventory. On top of that a chip is hidden when it currently matches **nothing** (the
 * `applicable` set), so the bar only offers filters that would actually do something — this
 * keeps the row from wrapping and leaves room to add more filters. A chip that is *active*
 * always stays (so it can be switched off), and until applicability is known every enabled
 * chip shows.
 *
 * Each chip is a toggle button (`aria-pressed`) styled with the Foundry {@link Button}
 * variants, and its help is a Foundry {@link Tooltip} (rich Markdown), never the browser's
 * plain `title`.
 */
interface StatusMeta {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Chip tooltip / accessible description. */
  readonly hint: string;
}

// The capability each chip needs to be enabled lives in the shared `STATUS_FILTER_FEATURE`
// SSOT (alongside `ITEM_STATUS_FILTERS`) so the applicability query and this bar can never
// disagree about which statuses a reduced module set offers.
const STATUS_META: Record<ItemStatusFilter, StatusMeta> = {
  'low-stock': {
    label: 'Low stock',
    icon: LowStockIcon,
    hint: 'Items at or below their reorder point.',
  },
  'out-of-stock': {
    label: 'Out of stock',
    icon: OutOfStockIcon,
    hint: 'Items that have run down to zero on hand.',
  },
  expiring: {
    label: 'Expiring',
    icon: ExpiryIcon,
    hint: 'Perishables past or nearing their expiry date.',
  },
  warranty: {
    label: 'Warranty',
    icon: WarrantyIcon,
    hint: 'Assets whose warranty has expired or expires soon.',
  },
  'on-loan': {
    label: 'On loan',
    icon: CheckoutIcon,
    hint: 'Items currently checked out to a contact.',
  },
  overdue: {
    label: 'Overdue',
    icon: DueDateIcon,
    hint: 'Items checked out and past their due date.',
  },
  'maintenance-due': {
    label: 'Maintenance due',
    icon: MaintenanceIcon,
    hint: 'Items with a service or calibration now due.',
  },
};

interface InventoryFilterBarProps {
  /** The currently-active status filters. */
  readonly value: ReadonlySet<ItemStatusFilter>;
  readonly onToggle: (status: ItemStatusFilter) => void;
  readonly onClear: () => void;
  /**
   * The statuses that currently match at least one item, so filters that would return nothing
   * can be hidden. `undefined` while this is still being computed — every enabled chip shows
   * until it is known, avoiding an empty flash.
   */
  readonly applicable?: ReadonlySet<ItemStatusFilter>;
  /** Disabled while the Visual Builder supersedes the quick filters (mirrors the search box). */
  readonly disabled?: boolean;
}

export function InventoryFilterBar({
  value,
  onToggle,
  onClear,
  applicable,
  disabled,
}: InventoryFilterBarProps) {
  const enabled = useEnabledFeatures();
  const available = ITEM_STATUS_FILTERS.filter((status) => {
    const feature = STATUS_FILTER_FEATURE[status];
    if (feature != null && !enabled.has(feature)) return false;
    // Declutter: drop a filter that matches nothing — but keep an active one (so it can be
    // switched off) and show everything until applicability has been computed.
    return value.has(status) || applicable == null || applicable.has(status);
  });

  // Nothing to offer (every filter gated off or matching nothing) → render no row at all.
  if (available.length === 0) return null;

  const activeCount = available.filter((status) => value.has(status)).length;

  return (
    <div
      role="group"
      aria-label="Filter by status"
      data-testid="inventory-filter-bar"
      className="flex flex-wrap items-center gap-2 pb-3"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        <FilterIcon aria-hidden />
        Filter
      </span>
      {available.map((status) => {
        const meta = STATUS_META[status];
        const Icon = meta.icon;
        const active = value.has(status);
        return (
          // `triggerTabIndex={-1}` avoids a duplicate tab stop (the Button is already
          // focusable); the wrapping `span` gives the tooltip a hover target even when the
          // Button is disabled (same pattern as the Inventory screen's "Duplicate item" action).
          <Tooltip key={status} content={meta.hint} triggerTabIndex={-1}>
            <span>
              <Button
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'outline'}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onToggle(status)}
                data-testid={`inventory-filter-${status}`}
              >
                <Icon />
                {meta.label}
              </Button>
            </span>
          </Tooltip>
        );
      })}
      {activeCount > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onClear}
          data-testid="inventory-filter-clear"
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
