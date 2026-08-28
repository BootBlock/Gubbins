import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/foundry';
import { PackageIcon } from '@/components/icons';
import type { CardFieldStoredValue, Item, LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useHighlightTarget } from '@/lib/highlight';
import { useItemDragSource } from '../item-drag';
import { DEFAULT_VISIBLE_CARD_FIELD_IDS, primaryCardField, type CardCustomField } from '../card-fields';
import { Thumbnail } from './Thumbnail';
import { ItemActions } from './ItemActions';
import { useCardClickAction } from './useCardClickAction';
import { FieldValue } from './ItemCardFields';
import { FavouriteStar } from './FavouriteIndicator';
import { CategoryGlyphFallback } from './CategoryGlyphWatermark';
import { EMPTY_CUSTOM_FIELDS, useResolvedCardFields } from './card-fields-render';
import type { ItemSelection } from './inventory-ui';
import { ItemGalleryTileCrashed, withItemCrashBoundary } from './ItemCrashBoundary';

/**
 * Gallery presentation (issue #444): the picture *is* the tile. A fixed-height image fills the
 * tile's width, and beneath it sit two lines — the item's name and one field.
 *
 * The boundary against {@link ItemCard} is deliberate and is stated in `view-modes.ts`: a card is
 * a record that happens to carry a 44px thumbnail, a gallery tile is a picture with a caption. So
 * this draws no `Surface`, no badge row, no hero metric and no ± stepper. The only edge is a
 * hairline ring on the picture itself, which is what the selected state thickens — so what the
 * eye reads is the wall of images rather than the frames around them.
 *
 * What it does keep is the item's action controls, on the caption line rather than over the
 * picture. The pointer-only body-click shortcut ({@link useCardClickAction}) is only defensible
 * while the same actions are reachable from a focusable, labelled control, so dropping them to
 * save chrome would quietly make the mode keyboard-inaccessible rather than merely plainer —
 * but floating them on the image (a destructive "remove" among them) would put chrome back on the
 * one surface the mode exists to keep clear. Beside the caption they cost no height: the two text
 * lines are already taller than the buttons.
 *
 * `memo`'d for the same reason as {@link ItemCard}: it renders inside the virtualised list, so a
 * tile whose props are referentially unchanged skips re-rendering as its siblings scroll.
 */
const ItemGalleryTileBody = memo(function ItemGalleryTile({
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
  ariaPosInSet,
  ariaSetSize,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  /** Tailwind text-colour class for the location's swatch tint, if any. */
  locationColorClass?: string;
  /** Edge-tint class painting the tile in its location's swatch (visual-flair F10), if coloured. */
  locationTintClass?: string;
  selection?: ItemSelection;
  /** Whether this tile is currently selected (only meaningful when `selection` is set). */
  selected?: boolean;
  /** Visible card-field ids in order (backlog E1); the first non-empty one becomes the caption. */
  fieldOrder?: readonly string[];
  /** This item's resolved category name, or null when it has no category. */
  categoryName?: string | null;
  /**
   * This item's category glyph, ignoring the decorative-watermark setting (see `itemGalleryProps`).
   * Drawn in the picture box when the item has no photo.
   */
  categoryGlyph?: string | null;
  /** The live custom-field catalog, keyed by field id (stable across the list). */
  customFields?: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values (fieldId → raw value), if loaded. */
  customValues?: ReadonlyMap<string, CardFieldStoredValue>;
  /** This item's tag names (issue #84), if the Tags card field is shown and they've loaded. */
  tags?: readonly string[];
  /** 1-based position in the whole result set, and its size — see {@link ItemCard} (issue #208). */
  ariaPosInSet?: number;
  ariaSetSize?: number;
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
  const caption = primaryCardField(fields);
  // Drag-to-move (spec §4), as on the card and row: `select-none` keeps a press-drag from
  // selecting the caption text, and the control-origin guard lives in the hook.
  const dragProps = useItemDragSource(item);
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  const hasPhoto = item.thumbnailBlob != null && item.thumbnailBlob.byteLength > 0;
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the body click is a pointer-only shortcut that only ever mirrors one of the tile's own focusable, labelled action-menu rows (details/move/label), so keyboard/AT users already have full parity; giving the tile itself an interactive role + tabindex would wrap those in a redundant, confusing nested tab stop (its `listitem` role is structural, and adds no tab stop).
    <div
      ref={ref}
      // One item of the list its container declares, carrying its absolute position so
      // virtualisation stays invisible to assistive tech. Like the card and the row, the body
      // click is a pointer-only shortcut mirroring the tile's own labelled action menu, so the
      // tile takes no interactive role or tab stop of its own.
      role="listitem"
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      {...dragProps}
      onClick={onClick}
      className={cn(
        'flex select-none flex-col gap-1.5 active:cursor-grabbing',
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        isHighlighted && 'animate-highlight',
      )}
    >
      <div
        className={cn(
          // The picture box is the tile. Its height is fixed (not an aspect ratio) so every row
          // of a responsive grid measures the same — a ratio would make the row height depend on
          // the column width, and the virtualiser's estimate along with it.
          'relative h-44 w-full overflow-hidden rounded-xl bg-secondary/40',
          // Selection reads on the picture itself, since there is no frame to tint.
          selected ? 'ring-2 ring-primary/70' : 'ring-1 ring-border/50',
          locationTintClass,
        )}
      >
        {hasPhoto ? (
          <Thumbnail bytes={item.thumbnailBlob} alt={item.name} className="size-full" />
        ) : categoryGlyph ? (
          <CategoryGlyphFallback glyph={categoryGlyph} />
        ) : (
          // Last resort: an item with neither a photo nor a category glyph. A typed glyph still
          // reads as "an item", where an empty box would read as a picture that failed to load.
          <span
            aria-hidden
            className="grid size-full place-items-center text-muted-foreground/40 [&_svg]:size-10"
          >
            <PackageIcon />
          </span>
        )}
        {/* The selection checkbox is the one control that does belong on the picture: with no
            frame to tint, the selected state has to read on the image itself, and the box has to
            sit where that ring is. Backed so it stays legible over any photograph. */}
        {selection ? (
          <div className="absolute left-1.5 top-1.5 rounded-md bg-card/85 p-1">
            <Checkbox
              checked={selected}
              onChange={() => selection.onToggle(item)}
              aria-label={t('inventory.select.item', { vars: { name: item.name } })}
              data-testid="item-select"
            />
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        {/* The name takes the tile's whole width. The action controls sit on the *caption* line
            below rather than beside it: a tile is narrower than a card, and buttons on this line
            would leave the name — the one thing every tile must be readable by — a third of the
            space and truncating far sooner than the picture it labels. */}
        <p className="flex items-center gap-1 text-sm font-medium">
          {item.isFavourite ? <FavouriteStar /> : null}
          <span className="min-w-0 truncate">{item.name}</span>
        </p>
        <div className="flex items-center gap-2">
          {/* The caption: the first configured field that has a value for this item. Rendered
              through the shared value renderer so a price, a colour or a tag list reads the same
              here as it does on a card. A tile with nothing to say still keeps this row, because
              the actions live on it. */}
          <p className="flex min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {caption ? <FieldValue field={caption} locationColorClass={locationColorClass} /> : null}
          </p>
          <ItemActions ref={actionsRef} item={item} locations={locations} compact />
        </div>
      </div>
    </div>
  );
});

/** The exported tile: {@link ItemGalleryTileBody} behind a per-item crash boundary (#313). */
export const ItemGalleryTile = withItemCrashBoundary(
  ItemGalleryTileBody,
  'item gallery tile',
  ItemGalleryTileCrashed,
);
