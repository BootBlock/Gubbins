import type { ComponentType } from 'react';
import { Button } from '@/components/foundry';
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
import { ITEM_STATUS_FILTERS, type ItemStatusFilter } from '@/db/repositories';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import type { FeatureId } from '@/features/modules/feature-registry';

/**
 * The inventory **status filter** bar (spec §3 / §4): a row of toggle chips for the common
 * "needs attention" filters — Low stock, Expiring, Overdue, Maintenance due. Selecting one
 * or more narrows the list to items matching *any* chosen concern (OR-combined server-side
 * via {@link buildStatusFilter}); the chips are additive to the location scope and search.
 *
 * A chip is only shown when its underlying capability is enabled (Modular UI, §4): Expiring
 * needs `perishables`, Warranty needs `warranty`, On loan / Overdue need `contacts` (the
 * borrow/loan facet), Maintenance due needs `maintenance`. Low stock and Out of stock are
 * core inventory and always available. Each chip is a toggle button (`aria-pressed`) styled
 * with the Foundry {@link Button} variants — the same pattern the header's "Visual search"
 * toggle uses — so it stays on the design tokens.
 */
interface StatusMeta {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** The capability that must be enabled for the chip to appear; omitted = always on. */
  readonly feature?: FeatureId;
  /** Chip tooltip / accessible description. */
  readonly hint: string;
}

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
    feature: 'perishables',
    hint: 'Perishables past or nearing their expiry date.',
  },
  warranty: {
    label: 'Warranty',
    icon: WarrantyIcon,
    feature: 'warranty',
    hint: 'Assets whose warranty has expired or expires soon.',
  },
  'on-loan': {
    label: 'On loan',
    icon: CheckoutIcon,
    feature: 'contacts',
    hint: 'Items currently checked out to a contact.',
  },
  overdue: {
    label: 'Overdue',
    icon: DueDateIcon,
    feature: 'contacts',
    hint: 'Items checked out and past their due date.',
  },
  'maintenance-due': {
    label: 'Maintenance due',
    icon: MaintenanceIcon,
    feature: 'maintenance',
    hint: 'Items with a service or calibration now due.',
  },
};

interface InventoryFilterBarProps {
  /** The currently-active status filters. */
  readonly value: ReadonlySet<ItemStatusFilter>;
  readonly onToggle: (status: ItemStatusFilter) => void;
  readonly onClear: () => void;
  /** Disabled while the Visual Builder supersedes the quick filters (mirrors the search box). */
  readonly disabled?: boolean;
}

export function InventoryFilterBar({ value, onToggle, onClear, disabled }: InventoryFilterBarProps) {
  const enabled = useEnabledFeatures();
  const available = ITEM_STATUS_FILTERS.filter((status) => {
    const feature = STATUS_META[status].feature;
    return feature == null || enabled.has(feature);
  });

  // No available chips (every optional facet off and low-stock somehow gated) → render nothing.
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
          <Button
            key={status}
            type="button"
            size="sm"
            variant={active ? 'secondary' : 'outline'}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onToggle(status)}
            title={meta.hint}
            data-testid={`inventory-filter-${status}`}
          >
            <Icon />
            {meta.label}
          </Button>
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
