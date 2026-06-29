import type { LocationOption } from './components/LocationSelect';

/** The minimal shape the parent picker needs from a location row. */
export interface ParentLocationRow {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly itemCount: number;
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
 * "top level" row, then every selectable location. System locations are never valid
 * parents; `excludeIds` additionally drops a location and its descendants when
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
      .filter((l) => !l.isSystem && !excludeIds?.has(l.id))
      .map((loc) => ({
        value: loc.id,
        label: loc.name,
        meta: itemCountMeta(loc.itemCount, quantity),
      })),
  ];
}
