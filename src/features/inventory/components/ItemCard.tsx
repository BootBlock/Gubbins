import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import { FolderIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useHighlightTarget } from '@/lib/highlight';
import { UNLIMITED_GLYPH, isUnlimited } from '../unlimited';
import { useItemDragSource } from '../item-drag';
import { DiscreteCardMetric } from './DiscreteCardMetric';
import { GaugeBar } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { Thumbnail } from './Thumbnail';
import { TrackingBadge, UnlimitedBadge } from './TrackingBadge';
import { ItemActions } from './ItemActions';
import { useCardClickAction } from './useCardClickAction';
import type { ItemSelection } from './inventory-ui';

/**
 * Visual-Heavy item presentation (spec §3): a large, striking card with bold
 * typography, the gauge visualisation front-and-centre, and tactile hover lift.
 * When `selection` is provided (the §6 batch QR-label flow, Phase 49) a selection
 * checkbox is shown.
 *
 * Wrapped in {@link memo}: like {@link ItemRow} it renders inside the virtualised list,
 * so a card whose props are referentially unchanged skips re-rendering as siblings scroll.
 * `selection` stays stable and `selected` is a plain boolean, so toggling one card
 * re-renders just that card.
 */
export const ItemCard = memo(function ItemCard({
  item,
  locations,
  locationName,
  locationColorClass,
  selection,
  selected = false,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  /** Tailwind text-colour class for the location's swatch tint, if any. */
  locationColorClass?: string;
  selection?: ItemSelection;
  /** Whether this card is currently selected (only meaningful when `selection` is set). */
  selected?: boolean;
}) {
  const { ref, isHighlighted } = useHighlightTarget<HTMLDivElement>(item.id);
  // Drag-to-move (spec §4): unified pointer drag for mouse, pen and touch. `select-none` keeps
  // a press-drag from selecting the card's text; the control-origin guard lives in the hook.
  const dragProps = useItemDragSource(item);
  // Click-to-act (spec §3): a plain click on the card body runs the user's `cardClickAction`.
  // Suppressed during batch selection, where a body click means "toggle this card". Like the
  // row, this is a pointer-only shortcut that only ever mirrors one of the card's own focusable,
  // labelled action buttons (details/move/label), so keyboard/AT users keep full parity without
  // the card itself becoming a redundant, nested-interactive tab stop — hence no role/tabindex.
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  return (
    <Surface
      ref={ref}
      interactive
      {...dragProps}
      onClick={onClick}
      className={cn(
        // Surface's `interactive` supplies the transition + hover shadow; the card takes a
        // slightly bigger lift (`-translate-y-1`, twMerge keeps the last), and no hover
        // grab-hand: the grabbing cursor appears only while actively pressing to drag
        // (`:active`); hover shows a pointer when the card body is click-actionable, else default.
        'flex select-none flex-col gap-4 p-5 hover:-translate-y-1 active:cursor-grabbing',
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        selected && 'ring-2 ring-primary/60',
        isHighlighted && 'animate-highlight',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {selection ? (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => selection.onToggle(item)}
              aria-label={`Select ${item.name}`}
              data-testid="item-select"
              className="mt-1 size-4 shrink-0 accent-primary"
            />
          ) : null}
          {item.thumbnailBlob ? (
            <Thumbnail
              bytes={item.thumbnailBlob}
              alt={item.name}
              className="size-11 shrink-0 rounded-lg border border-border/60"
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight">
              {item.name}
              {item.serialNo !== null ? (
                <span className="ml-1 text-muted-foreground">#{item.serialNo}</span>
              ) : null}
            </h3>
            <p
              className={cn(
                'mt-1 inline-flex items-center gap-1.5 text-xs [&_svg]:size-3.5',
                locationColorClass ?? 'text-muted-foreground',
              )}
            >
              <FolderIcon />
              {locationName}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <TrackingBadge mode={item.trackingMode} />
          {isUnlimited(item) ? <UnlimitedBadge /> : null}
        </div>
      </div>

      <div className="flex-1">
        {isUnlimited(item) ? (
          <div className="flex items-center justify-between">
            <span
              className="text-2xl font-bold text-glyph-scan"
              aria-label="Unlimited supply"
              title="Unlimited supply"
            >
              {UNLIMITED_GLYPH}
            </span>
            <span className="text-xs text-muted-foreground">unlimited supply</span>
          </div>
        ) : item.gauge ? (
          <GaugeBar gauge={item.gauge} />
        ) : item.trackingMode === 'SERIALISED' ? (
          <p className="text-sm text-muted-foreground">Single serialised unit</p>
        ) : item.trackingMode === 'UNTRACKED' ? (
          <p className="text-sm text-muted-foreground">Presence only — not counted</p>
        ) : (
          // The ± stepper below already shows the on-hand quantity, so this hero shows a
          // different, user-chosen signal (stock health or total value) instead of a
          // duplicated number (spec §3; the `visualCardMetric` preference).
          <DiscreteCardMetric item={item} />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        {item.trackingMode === 'DISCRETE' && item.isActive && !isUnlimited(item) ? (
          <QuantityStepper id={item.id} quantity={item.quantity} />
        ) : (
          <span />
        )}
        <ItemActions ref={actionsRef} item={item} locations={locations} compact />
      </div>
    </Surface>
  );
});
