import type { Item, LocationWithCount } from '@/db/repositories';
import { assertExhaustive } from '@/lib/exhaustive';
import type { ItemDensity } from '@/state/stores/useLayoutStore';
import { ItemCard } from './ItemCard';
import { ItemCompactRow } from './ItemCompactRow';
import { ItemGalleryTile } from './ItemGalleryTile';
import { ItemRow } from './ItemRow';
import {
  cardFieldProps,
  itemCardProps,
  itemGalleryProps,
  type CardFieldsListContext,
} from './card-fields-render';
import type { ItemSelection } from './inventory-ui';

/**
 * One item, drawn in whichever per-item View mode is active (issue #444).
 *
 * The flat virtualised list and both of the grouped view's section bodies render exactly the same
 * item the same way, so the mode fork lives here once instead of three times. Adding a fifth
 * per-item mode is then a case here, not three parallel edits that can half-land.
 *
 * Deliberately **not** `memo`'d. The bail-out that matters is the one on each presentation
 * itself, and that still happens — this wrapper only picks which element to return, so React
 * reaches the memoised card/row/tile and skips its subtree exactly as before. Memoising here
 * would buy nothing anyway: `cardFields` is a fresh object on every list render, so a shallow
 * prop compare could never hit.
 *
 * `table` is excluded rather than defaulted: a table row needs the shared `grid-template-columns`
 * and an absolute `aria-rowindex` that only its own `role="table"` wrapper can supply, so every
 * call site intercepts it above this point. Typing it out of {@link ItemPresentationDensity} is
 * what stops a caller quietly reaching here with it.
 */
export type ItemPresentationDensity = Exclude<ItemDensity, 'table'>;

export interface ItemPresentationProps {
  readonly density: ItemPresentationDensity;
  readonly item: Item;
  readonly locations: readonly LocationWithCount[];
  readonly locationName: (id: string) => string;
  readonly locationColorClass?: (id: string) => string | undefined;
  readonly locationTintClass?: (id: string) => string | undefined;
  readonly selection?: ItemSelection;
  readonly selected: boolean;
  /** 1-based absolute position in the result set, and its size (issue #208). */
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
  readonly cardFields: CardFieldsListContext;
}

export function ItemPresentation({
  density,
  item,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selected,
  ariaPosInSet,
  ariaSetSize,
  cardFields,
}: ItemPresentationProps) {
  // Everything the four presentations share. Each then adds only what is genuinely its own:
  // the card its decorative glyph watermark, the gallery tile its ungated glyph.
  const common = {
    item,
    locations,
    locationName: locationName(item.locationId),
    locationColorClass: locationColorClass?.(item.locationId),
    locationTintClass: locationTintClass?.(item.locationId),
    selection,
    selected,
    ariaPosInSet,
    ariaSetSize,
  };
  switch (density) {
    case 'visual':
      return <ItemCard {...common} {...itemCardProps(cardFields, item)} />;
    case 'gallery':
      return <ItemGalleryTile {...common} {...itemGalleryProps(cardFields, item)} />;
    case 'data':
      return <ItemRow {...common} {...cardFieldProps(cardFields, item)} />;
    case 'compact':
      return <ItemCompactRow {...common} {...cardFieldProps(cardFields, item)} />;
    default:
      // A component has no declared return type to make the switch exhaustive on its own
      // (issue #355), so the guard is explicit: adding a per-item density without a case here
      // stops compiling rather than silently rendering nothing.
      assertExhaustive(density);
      return null;
  }
}
