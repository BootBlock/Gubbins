import type { LucideIcon } from 'lucide-react';
import {
  CompactViewIcon,
  DataDensityIcon,
  GalleryViewIcon,
  MapViewIcon,
  TableViewIcon,
  TreemapViewIcon,
  VisualDensityIcon,
} from '@/components/icons';
import type { MessageKey } from '@/features/i18n';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';

/**
 * The inventory grid's **View** axis (spec §3) — how the collection is *presented*, kept orthogonal
 * to the grouping axis (how the list is arranged; see {@link GROUP_MODES}) and the ordering axis
 * (see {@link SORT_MODES}). The first five draw the inventory item-by-item — Card, Gallery tiles,
 * dense Data rows, Compact lines, or a spreadsheet Table — and the last two are whole-collection
 * visualisations: a spatial location Map and a value Treemap. The per-item card view is still
 * stored under the `visual` key; its label just reads "Card".
 *
 * ## Where the four per-item boundaries are drawn (issue #444)
 *
 * Card and Gallery are both multi-column grids, and Data and Compact are both one-item-per-line,
 * so each pair needs a boundary that is a *difference in kind* rather than a difference in
 * padding. Two axes separate all four: how much of the item's picture is drawn, and how much of
 * its metadata comes with it.
 *
 * | Mode | Picture | Metadata | Chrome |
 * | --- | --- | --- | --- |
 * | Card | a 44px thumbnail beside the name | the whole configured field list, the hero metric and the ± stepper | a `Surface` card, its badge row and its action footer |
 * | Gallery | the tile itself — a 176px image, or the category glyph in its place | the name and **one** field | none but a hairline ring round the picture |
 * | Data | none | the whole configured field list, inline, plus the badge and stock value | a bordered strip |
 * | Compact | none | the name and **one** field | none; a single text line |
 *
 * Read across a row and no two are the same object: Card is a record with a picture on it,
 * Gallery is a picture with a caption, Data is a record on one strip, Compact is a line of text.
 * The one thing all four keep is the item's action menu, because the pointer-only body-click
 * shortcut is only defensible while every mode still offers those actions to a keyboard user.
 *
 * Lives in its own module rather than inline in `InventoryScreen` so it sits beside its two sibling
 * axes *and* so the catalog-drift test can import it without dragging in the whole screen — the
 * three axes are then guarded identically.
 *
 * Kept a plain descriptor list rather than wiring components, so the control stays a dumb,
 * exhaustive renderer of whatever modes exist.
 */
export interface ViewModeDescriptor {
  readonly value: LayoutDensity;
  /**
   * The *displayed* text comes from the catalog via {@link labelKey}; this English field is the
   * base reference, held byte-identical to `en.json` by the catalog-drift test.
   */
  readonly label: string;
  readonly labelKey: MessageKey;
  readonly icon: LucideIcon;
}

export const DENSITY_MODES: readonly ViewModeDescriptor[] = [
  { value: 'visual', label: 'Card', labelKey: 'inventory.view.card', icon: VisualDensityIcon },
  { value: 'gallery', label: 'Gallery', labelKey: 'inventory.view.gallery', icon: GalleryViewIcon },
  { value: 'data', label: 'Data', labelKey: 'inventory.view.data', icon: DataDensityIcon },
  { value: 'compact', label: 'Compact', labelKey: 'inventory.view.compact', icon: CompactViewIcon },
  { value: 'table', label: 'Table', labelKey: 'inventory.view.table', icon: TableViewIcon },
  { value: 'map', label: 'Location map', labelKey: 'inventory.view.map', icon: MapViewIcon },
  {
    value: 'treemap',
    label: 'Value treemap',
    labelKey: 'inventory.view.treemap',
    icon: TreemapViewIcon,
  },
];
