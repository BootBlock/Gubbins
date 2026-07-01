import type { LocationOption } from './components/LocationSelect';
import { locationColorTextClass } from './location-color';

/** The minimal shape the location pickers need from a location row. */
export interface ParentLocationRow {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly itemCount: number;
  /** The location's stored colour swatch key (tints its name in the picker). */
  readonly color: string | null;
  /** Epoch-ms the location was archived; null = active. Archived rows are hidden. */
  readonly archivedAt?: number | null;
}

/**
 * The right-aligned item-count hint for a parent-picker row: an empty location shows
 * a terse `"-"` (far quicker to scan than `"0 items"`), otherwise a locale-formatted,
 * pluralised count. The `quantity` argument is `Formatters.quantity` — passed in (not
 * imported) so this stays a pure, directly-testable function.
 */
export function itemCountMeta(count: number, quantity: (value: number) => string): string {
  if (count === 0) return '-';
  return `${quantity(count)} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Build the {@link LocationSelect} options for a location **Parent** picker: a leading
 * "top level" row, then every selectable location. System and archived locations are never
 * valid parents; `excludeIds` additionally drops a location and its descendants when
 * *re-parenting* (so a node can't be moved under itself or its own child — §7.5.3).
 * Each location row carries the {@link itemCountMeta} hint.
 */
export function buildParentOptions(
  locations: readonly ParentLocationRow[],
  quantity: (value: number) => string,
  excludeIds?: ReadonlySet<string>,
): LocationOption[] {
  return [
    { value: '', label: '— Top level —' },
    ...locations
      .filter((l) => !l.isSystem && !l.archivedAt && !excludeIds?.has(l.id))
      .map((loc) => ({
        value: loc.id,
        label: loc.name,
        meta: itemCountMeta(loc.itemCount, quantity),
        colorClass: locationColorTextClass(loc.color),
      })),
  ];
}

/**
 * Build the {@link LocationSelect} options for an *item's* location picker (Add / Move
 * Item): every non-archived location is selectable — including the system **Unassigned** /
 * **In Transit** rows, where an item legitimately lives — and there is no "top level" entry.
 * An archived location is hidden as a *target*, except `keepId` (the item's current home),
 * which is always kept so the picker can still show where the item lives. Each row carries
 * the count hint and the location's colour tint.
 */
export function buildItemLocationOptions(
  locations: readonly ParentLocationRow[],
  quantity: (value: number) => string,
  keepId?: string,
): LocationOption[] {
  return locations
    .filter((loc) => !loc.archivedAt || loc.id === keepId)
    .map((loc) => ({
      value: loc.id,
      label: loc.name,
      meta: itemCountMeta(loc.itemCount, quantity),
      colorClass: locationColorTextClass(loc.color),
    }));
}
