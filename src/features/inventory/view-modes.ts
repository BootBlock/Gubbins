import type { LucideIcon } from 'lucide-react';
import {
  DataDensityIcon,
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
 * (see {@link SORT_MODES}). The first three draw the inventory item-by-item — Card, dense Data rows,
 * or a spreadsheet Table — and the last two are whole-collection visualisations: a spatial location
 * Map and a value Treemap. The per-item card view is still stored under the `visual` key; its label
 * just reads "Card".
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
  { value: 'data', label: 'Data', labelKey: 'inventory.view.data', icon: DataDensityIcon },
  { value: 'table', label: 'Table', labelKey: 'inventory.view.table', icon: TableViewIcon },
  { value: 'map', label: 'Location map', labelKey: 'inventory.view.map', icon: MapViewIcon },
  {
    value: 'treemap',
    label: 'Value treemap',
    labelKey: 'inventory.view.treemap',
    icon: TreemapViewIcon,
  },
];
