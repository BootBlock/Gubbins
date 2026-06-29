import { cn } from '@/lib/utils';
import { Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { DiscreteIcon, GaugeIcon, SerialisedIcon } from '@/components/icons';
import type { TrackingMode } from '@/db/repositories';
import { TRACKING_MODE_LABELS } from './inventory-ui';

const ICONS: Record<TrackingMode, typeof DiscreteIcon> = {
  DISCRETE: DiscreteIcon,
  SERIALISED: SerialisedIcon,
  CONSUMABLE_GAUGE: GaugeIcon,
};

const DESCRIPTIONS: Record<TrackingMode, string> = {
  DISCRETE: '**Bulk** — counted as a whole-number quantity (e.g. *screws*, *resistors*). Use the ± stepper to add or remove stock.',
  SERIALISED:
    '**Serialised** — a single, uniquely identified unit (quantity fixed at `1`). Adding several will clone them into distinct records.',
  CONSUMABLE_GAUGE:
    '**Consumable** — material that degrades continuously (e.g. *filament*, *resin*). Tracked by remaining amount with a low-stock gauge rather than a count.',
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
