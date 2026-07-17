import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Surface, usePointerTilt } from '@/components/foundry';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useHighlightTarget } from '@/lib/highlight';
import { UNLIMITED_GLYPH, isUnlimited } from '../unlimited';
import { useItemDragSource } from '../item-drag';
import { DEFAULT_VISIBLE_CARD_FIELD_IDS, type CardCustomField } from '../card-fields';
import { DiscreteCardMetric } from './DiscreteCardMetric';
import { GaugeBar } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { Thumbnail } from './Thumbnail';
import { UnlimitedBadge } from './TrackingBadge';
import { CardBadge } from './CardBadge';
import { ItemActions } from './ItemActions';
import { useCardClickAction } from './useCardClickAction';
import { CardFieldList } from './ItemCardFields';
import { FavouriteCardWatermark } from './FavouriteIndicator';
import { CategoryGlyphWatermark } from './CategoryGlyphWatermark';
import { EMPTY_CUSTOM_FIELDS, useResolvedCardFields } from './card-fields-render';
import { itemRarity } from '../rarity';
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
  locationTintClass,
  selection,
  selected = false,
  fieldOrder = DEFAULT_VISIBLE_CARD_FIELD_IDS,
  categoryName = null,
  categoryGlyph = null,
  customFields = EMPTY_CUSTOM_FIELDS,
  customValues,
  tags,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  /** Tailwind text-colour class for the location's swatch tint, if any. */
  locationColorClass?: string;
  /** Edge-tint class painting the card in its location's swatch (visual-flair F10), if coloured. */
  locationTintClass?: string;
  selection?: ItemSelection;
  /** Whether this card is currently selected (only meaningful when `selection` is set). */
  selected?: boolean;
  /** Visible card-field ids in order (backlog E1); defaults to the shipped Location + Category. */
  fieldOrder?: readonly string[];
  /** This item's resolved category name, or null when it has no category. */
  categoryName?: string | null;
  /**
   * This item's category glyph (issue #83), or null when the category has none or the global
   * card-watermark setting is off. When set, it's painted as a faint greyscale corner watermark.
   */
  categoryGlyph?: string | null;
  /** The live custom-field catalog, keyed by field id (stable across the list). */
  customFields?: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values (fieldId → raw value), if loaded. */
  customValues?: ReadonlyMap<string, string>;
  /** This item's tag names (issue #84), if the Tags card field is shown and they've loaded. */
  tags?: readonly string[];
}) {
  const t = useT();
  const { ref, isHighlighted } = useHighlightTarget<HTMLDivElement>(item.id);
  const fields = useResolvedCardFields(item, {
    order: fieldOrder,
    locationName,
    categoryName,
    customFields,
    customValues,
    tags,
  });
  // Drag-to-move (spec §4): unified pointer drag for mouse, pen and touch. `select-none` keeps
  // a press-drag from selecting the card's text; the control-origin guard lives in the hook.
  const dragProps = useItemDragSource(item);
  // Click-to-act (spec §3): a plain click on the card body runs the user's `cardClickAction`.
  // Suppressed during batch selection, where a body click means "toggle this card". Like the
  // row, this is a pointer-only shortcut that only ever mirrors one of the card's own focusable,
  // labelled action buttons (details/move/label), so keyboard/AT users keep full parity without
  // the card itself becoming a redundant, nested-interactive tab stop — hence no role/tabindex.
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  // Pointer tilt/parallax/glare (F7): a subtle 3D lean toward the cursor with a moving specular
  // glare, gated to fine pointers + full motion in one seam. Returns no handlers (nothing attached)
  // under reduced motion or on touch. Pure decoration — see `usePointerTilt`.
  const tiltProps = usePointerTilt();
  // Decorative "Collector cards" rarity (Appearance flair). Only ~5% of items are collectors
  // (deterministic from the name); the rest get `null` — no frame. Pure + cheap. On the card this
  // drives only the rarity-tinted *border* (painted by CSS when the toggle is on at the maximal
  // animation level); the rarity gem badge itself lives in the item's detail dialog, not here.
  const rarity = itemRarity(item);
  return (
    <Surface
      ref={ref}
      interactive
      {...dragProps}
      {...tiltProps}
      onClick={onClick}
      data-rarity={rarity ?? undefined}
      className={cn(
        // Surface's `interactive` supplies the transition + hover shadow; the card takes a
        // slightly bigger lift (`-translate-y-1`, twMerge keeps the last), and no hover
        // grab-hand: the grabbing cursor appears only while actively pressing to drag
        // (`:active`); hover shows a pointer when the card body is click-actionable, else default.
        'flex select-none flex-col gap-4 p-5 hover:-translate-y-1 active:cursor-grabbing',
        // Spotlight ring (F5): a slow accent-tinted conic "comet" sweeps the card's edge
        // while it is the focal card — the ring is invisible/paused at rest and only lights
        // for the single card under `:hover`/`:focus-within`, so exactly one is ever lit and
        // it stays safe on the virtualised list (no per-mount entrance to re-fire on recycle).
        // Decoration only — the hover-lift and the real focus ring remain the focus signals.
        'gubbins-spotlight-border',
        // Pointer tilt/parallax/glare (F7): leans toward the cursor on hover with a moving glare.
        // The class only *consumes* the `--tilt-*` vars `usePointerTilt` writes; every active rule
        // is gated to fine-pointer + full-motion in the stylesheet, so on touch / reduced motion it
        // is inert (and no handlers are attached). Its `transform` composes with the `-translate-y-1`
        // hover-lift (a `translate`) without clobbering it.
        'gubbins-tilt',
        // Collector-card rarity frame (Appearance flair): only on the ~5% of items that are
        // collectors (`rarity != null`), pairing with `data-rarity` to tint the card's border to
        // its tier. Inert (no visuals) unless the gamify toggle is on and the maximal animation
        // level is active — the CSS gates both the frame and the gem badge.
        rarity && 'gubbins-rarity',
        // Border on the left edge only (issue #54): Surface paints a subtle border on all four
        // sides, but on the card that competes with — and boxes in — the location accent that runs
        // down the left edge (the F10 tint spine below). This class drops the top/right/bottom
        // borders so each card carries a single left border, letting the location colour read as
        // that edge. It restores the full frame under high contrast (an accessibility affordance)
        // and for the collector-card rarity frame, so those keep their box — see `styles/index.css`.
        'gubbins-card-edge',
        // Per-location accent tint (F10): a faint left-edge accent in this card's location swatch
        // so the grid reads location-clustered at a glance. A painted background layer (no border /
        // no pseudo — both taken by F5/F7), static, and undefined for an uncoloured location.
        locationTintClass,
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        selected && 'ring-2 ring-primary/60',
        isHighlighted && 'animate-highlight',
      )}
    >
      {/* Category glyph watermark (issue #83): a large, faint greyscale emoji in the bottom-right
          of the card background when the item's category carries a glyph (and the global setting
          is on). Sits behind the content, like the favourite star. Decorative — the category name
          is already in the card's field list for AT. Painted first so the favourite star, when
          both are present, hangs over it in the same corner. */}
      {categoryGlyph ? <CategoryGlyphWatermark glyph={categoryGlyph} /> : null}
      {/* Favourite flair (issue #23): a faint gold star hung 50% off the bottom-right corner,
          clipped to the card. Decorative — the sr-only label below carries the state to AT. */}
      {item.isFavourite ? (
        <>
          <FavouriteCardWatermark />
          <span className="sr-only">{t('inventory.favourite.badge')}</span>
        </>
      ) : null}
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
              // `gubbins-tilt-layer` (F7): drifts against the tilt for a counter-parallax so the
              // thumbnail reads as floating above the card face. Inert unless the card is tilting.
              className="gubbins-tilt-layer size-11 shrink-0 rounded-lg border border-border/60"
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight">
              {item.name}
              {item.serialNo !== null ? (
                <span className="ml-1 text-muted-foreground">#{item.serialNo}</span>
              ) : null}
            </h3>
            {/* The manufacturer/brand as a subtitle directly under the name (issue #107), when the
                item has one — a quick identity cue distinct from the configurable field list below. */}
            {item.manufacturer && item.manufacturer.trim() !== '' ? (
              <p className="truncate text-xs text-muted-foreground">{item.manufacturer}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <CardBadge item={item} />
          {isUnlimited(item) ? <UnlimitedBadge /> : null}
        </div>
      </div>

      {/* The user-configured attribute list (backlog E1) — location, category and any other
          chosen built-in / custom fields. Every visible field renders a row (empty ⇒ em-dash),
          so a card's height depends only on the configuration, never the item, keeping the
          virtualised list's per-card measurement stable. */}
      <CardFieldList fields={fields} locationColorClass={locationColorClass} />

      {/* `gubbins-tilt-layer` (F7): the hero visualisation is the card's focal point, so it takes
          the counter-parallax drift for depth. Inert (no translate) unless the card is tilting. */}
      <div className="gubbins-tilt-layer flex-1">
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
