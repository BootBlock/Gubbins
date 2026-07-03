import { cn } from '@/lib/utils';
import { Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { DiscreteIcon, GaugeIcon, InfinityIcon, SerialisedIcon, UntrackedIcon } from '@/components/icons';
import type { TrackingMode } from '@/db/repositories';
import { TRACKING_MODE_LABELS } from './inventory-ui';

const ICONS: Record<TrackingMode, typeof DiscreteIcon> = {
  DISCRETE: DiscreteIcon,
  SERIALISED: SerialisedIcon,
  CONSUMABLE_GAUGE: GaugeIcon,
  UNTRACKED: UntrackedIcon,
};

const DESCRIPTIONS: Record<TrackingMode, string> = {
  DISCRETE:
    '**Bulk** — counted as a whole-number quantity (e.g. *screws*, *resistors*). Use the ± stepper to add or remove stock.',
  SERIALISED:
    '**Serialised** — a single, uniquely identified unit (quantity fixed at `1`). Adding several will clone them into distinct records.',
  CONSUMABLE_GAUGE:
    '**Consumable** — material that degrades continuously (e.g. *filament*, *resin*). Tracked by remaining amount with a low-stock gauge rather than a count.',
  UNTRACKED:
    '**Untracked** — a presence-only record (e.g. *the bench vice*, *a reference manual*). Catalogued, searchable and locatable, but with no quantity to count.',
};

/** A small pill identifying an item's tracking level (spec §4), with a rich tooltip. */
export function TrackingBadge({ mode, className }: { mode: TrackingMode; className?: string }) {
  const Icon = ICONS[mode];
  return (
    <Tooltip content={DESCRIPTIONS[mode]} triggerTabIndex={-1} openDelayMs={INFO_OPEN_DELAY_MS}>
      <span
        className={cn(
          'inline-flex cursor-help items-center gap-1 rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-xs font-medium text-muted-foreground [&_svg]:size-3',
          className,
        )}
      >
        <Icon />
        {TRACKING_MODE_LABELS[mode]}
      </span>
    </Tooltip>
  );
}

/**
 * A small ∞ pill flagging an "unlimited supply" item (Phase 82) — an effectively infinite
 * source. Sits next to the {@link TrackingBadge}; reuses the badge's token classes and tints
 * the glyph with a `text-glyph-*` token.
 */
export function UnlimitedBadge({ className }: { className?: string }) {
  return (
    <Tooltip
      content="**Unlimited supply** — an effectively infinite source. Never runs low; excluded from counts, valuation and the shopping list."
      triggerTabIndex={-1}
      openDelayMs={INFO_OPEN_DELAY_MS}
    >
      <span
        className={cn(
          'inline-flex cursor-help items-center gap-1 rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-xs font-medium text-glyph-scan [&_svg]:size-3',
          className,
        )}
      >
        <InfinityIcon />
        Unlimited
      </span>
    </Tooltip>
  );
}
