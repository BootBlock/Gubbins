import { cn } from '@/lib/utils';
import { Money, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { resolveCardBadge } from '../card-badge';
import { TrackingBadge } from './TrackingBadge';
import { CONDITION_COLOR_CLASS, CONDITION_LABELS } from './inventory-ui';

/** Shared pill chrome, matching the {@link TrackingBadge} / UnlimitedBadge tokens. */
const PILL =
  'inline-flex items-center gap-1 rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-xs font-medium';

const MONEY_TOOLTIP = {
  unit: '**Unit price** — the cost of a single unit of this item.',
  total: '**Total value** — the unit cost multiplied by the on-hand quantity.',
} as const;

/**
 * The item card/row's top-right badge slot (issue #117). What it shows is a per-device
 * preference ({@link usePreferencesStore.cardBadgeContent}) with a fallback
 * ({@link usePreferencesStore.cardBadgeFallback}) for items the chosen content can't apply to —
 * both resolved against the item by the pure {@link resolveCardBadge} seam. The default is the
 * tracking-mode pill, so out of the box this renders exactly the historic {@link TrackingBadge}.
 *
 * Money and condition keep the Foundry Money control / the `text-cond-*` condition token here
 * (design-token house rules), so this component only maps the resolved descriptor to JSX. When
 * the slot resolves to nothing it renders `null`, leaving the row's layout untouched.
 */
export function CardBadge({ item, className }: { item: Item; className?: string }) {
  const content = usePreferencesStore((s) => s.cardBadgeContent);
  const fallback = usePreferencesStore((s) => s.cardBadgeFallback);
  const badge = resolveCardBadge(item, content, fallback);

  switch (badge.kind) {
    case 'tracking':
      return <TrackingBadge mode={badge.mode} className={className} />;
    case 'money':
      return (
        <Tooltip content={MONEY_TOOLTIP[badge.scope]} triggerTabIndex={-1} openDelayMs={INFO_OPEN_DELAY_MS}>
          <span className={cn(PILL, 'cursor-help text-muted-foreground', className)}>
            <Money value={badge.amount} />
          </span>
        </Tooltip>
      );
    case 'condition':
      return (
        <span className={cn(PILL, CONDITION_COLOR_CLASS[badge.condition], className)}>
          {CONDITION_LABELS[badge.condition]}
        </span>
      );
    case 'none':
      return null;
  }
}
