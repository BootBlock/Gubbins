import type { ItemSort } from '@/db/repositories';
import type { MessageKey } from '@/features/i18n';
import type { InventorySort, InventorySortField } from '@/state/stores/useLayoutStore';

/**
 * The inventory grid's **ordering** axis (spec §3) — which field the list is sorted by and in
 * which direction. Orthogonal to both the density axis (how each item is *drawn*) and the
 * grouping axis (how the list is *arranged*), exactly as `GROUP_MODES` is.
 *
 * This is the single source of truth for the fields the "Sort by" control offers and how each
 * reads in the UI. The sortable set is fixed by the data layer's allow-list (`ITEM_SORT_FIELDS`
 * in `db/repositories/item/sql.ts`) — a field that isn't on that list can't be ordered by, so
 * adding a mode here means adding it there first.
 *
 * Kept a plain descriptor list (label + hint + the direction each way *means*) rather than
 * wiring components, so the control stays a dumb, exhaustive renderer of whatever modes exist.
 */
export interface SortModeDescriptor {
  readonly value: InventorySortField;
  /**
   * Trigger/menu label — self-describing so "Default" never reads as an empty state. The
   * *displayed* text comes from the catalog via {@link labelKey}; this English field is the base
   * reference, held byte-identical to `en.json` by the catalog-drift test.
   */
  readonly label: string;
  readonly labelKey: MessageKey;
  /**
   * One-line explanation, intended as the option's help text. Not surfaced by any control yet, so
   * it is deliberately *not* in the message catalog — see the same note on `GroupModeDescriptor`.
   */
  readonly hint: string;
  /**
   * What each direction means for *this* field, so the direction control reads naturally
   * ("A → Z" for a name, "Newest first" for a date) rather than a bare "Ascending". `null` for
   * the default order, which has no user-facing direction.
   *
   * Labels and keys are held in **one** object rather than two parallel nullable fields, so a
   * field can't end up with one kind's wording under another kind's keys, and "has a direction"
   * is a single check instead of two that must agree.
   */
  readonly directions: DirectionPair | null;
  /**
   * The direction this field sorts by when the user *first* picks it. Text reads naturally
   * ascending (A → Z), while numbers and dates are almost always wanted biggest/newest first
   * ("what do I have most of", "what did I just change").
   */
  readonly naturalDirection: 'asc' | 'desc';
}

/** The two ways one field can run, named for what the direction *means* for that kind of value. */
export interface DirectionPair {
  /**
   * English base reference, held byte-identical to `en.json` by the catalog-drift test. The
   * displayed text comes from {@link keys}.
   */
  readonly labels: { readonly asc: string; readonly desc: string };
  readonly keys: { readonly asc: MessageKey; readonly desc: MessageKey };
}

// Three kinds of value, each with its own natural reading. Shared by reference across the
// descriptors below, so every text-valued field words its directions identically.
const TEXT_DIRECTIONS: DirectionPair = {
  labels: { asc: 'A → Z', desc: 'Z → A' },
  keys: { asc: 'inventory.sort.direction.text.asc', desc: 'inventory.sort.direction.text.desc' },
};
const NUMBER_DIRECTIONS: DirectionPair = {
  labels: { asc: 'Lowest first', desc: 'Highest first' },
  keys: { asc: 'inventory.sort.direction.number.asc', desc: 'inventory.sort.direction.number.desc' },
};
const DATE_DIRECTIONS: DirectionPair = {
  labels: { asc: 'Oldest first', desc: 'Newest first' },
  keys: { asc: 'inventory.sort.direction.date.asc', desc: 'inventory.sort.direction.date.desc' },
};

export const SORT_MODES: readonly SortModeDescriptor[] = [
  {
    value: 'default',
    label: 'Default',
    labelKey: 'inventory.sort.default',
    hint: 'Favourites first, then alphabetically by name.',
    directions: null,
    naturalDirection: 'asc',
  },
  {
    value: 'name',
    label: 'Name',
    labelKey: 'inventory.sort.name',
    hint: "Alphabetically by the item's name.",
    directions: TEXT_DIRECTIONS,
    naturalDirection: 'asc',
  },
  {
    value: 'quantity',
    label: 'Quantity',
    labelKey: 'inventory.sort.quantity',
    hint: 'By how much stock you hold — find the fullest or the emptiest.',
    directions: NUMBER_DIRECTIONS,
    naturalDirection: 'desc',
  },
  {
    value: 'unitCost',
    label: 'Unit cost',
    labelKey: 'inventory.sort.unitCost',
    hint: 'By what one unit costs — find the most and least valuable items.',
    directions: NUMBER_DIRECTIONS,
    naturalDirection: 'desc',
  },
  {
    value: 'manufacturer',
    label: 'Manufacturer',
    labelKey: 'inventory.sort.manufacturer',
    hint: 'Alphabetically by manufacturer, so one brand’s items sit together.',
    directions: TEXT_DIRECTIONS,
    naturalDirection: 'asc',
  },
  {
    value: 'mpn',
    label: 'MPN',
    labelKey: 'inventory.sort.mpn',
    hint: 'By manufacturer part number.',
    directions: TEXT_DIRECTIONS,
    naturalDirection: 'asc',
  },
  {
    value: 'serialNo',
    label: 'Serial number',
    labelKey: 'inventory.sort.serialNo',
    hint: 'By serial number, for individually-tracked items.',
    directions: TEXT_DIRECTIONS,
    naturalDirection: 'asc',
  },
  {
    value: 'createdAt',
    label: 'Date added',
    labelKey: 'inventory.sort.createdAt',
    hint: 'By when the item was added to your inventory.',
    directions: DATE_DIRECTIONS,
    naturalDirection: 'desc',
  },
  {
    value: 'updatedAt',
    label: 'Last updated',
    labelKey: 'inventory.sort.updatedAt',
    hint: 'By when the item last changed — see what you’ve touched recently.',
    directions: DATE_DIRECTIONS,
    naturalDirection: 'desc',
  },
];

/** Look up a mode descriptor, falling back to the default entry for an unknown field. */
export function sortMode(field: InventorySortField): SortModeDescriptor {
  return SORT_MODES.find((m) => m.value === field) ?? SORT_MODES[0]!;
}

/**
 * Translate the UI's sort selection into the repository's `sort` argument, or `undefined` for
 * the `default` field — which is not "no ordering" but *the repository's own* default order
 * (favourites first, then name/serial/created), so it must stay absent rather than be encoded.
 *
 * Returned as a single-term array because the data layer takes a list; the UI only ever offers
 * one term, and the repository appends its own `items.id` tiebreak for deterministic paging.
 */
export function toItemSort(sort: InventorySort): readonly ItemSort[] | undefined {
  if (sort.field === 'default') return undefined;
  return [{ field: sort.field, direction: sort.direction }];
}

/**
 * The direction a field sorts by when the user *first* picks it (see
 * {@link SortModeDescriptor.naturalDirection}). Activating an already-active column toggles
 * from here rather than always restarting at ascending.
 */
export function initialDirection(field: InventorySortField): 'asc' | 'desc' {
  return sortMode(field).naturalDirection;
}

/**
 * The next sort state when the user activates a sortable column header: a *new* column adopts
 * that field at its natural {@link initialDirection}; the *active* column flips direction; and
 * flipping back past the field's natural direction returns to the default order, so a header
 * cycles ordered → reversed → unordered rather than trapping the user in a sort.
 */
export function nextSortForColumn(current: InventorySort, field: InventorySortField): InventorySort {
  if (current.field !== field) return { field, direction: initialDirection(field) };
  if (current.direction === initialDirection(field)) {
    return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { field: 'default', direction: 'asc' };
}

/**
 * The `aria-sort` value for a column header, so assistive technology announces the ordering
 * the sighted user sees. Only the active column reports a direction; every other sortable
 * column reports `none` (never omitted — that would read as "not sortable").
 */
export function columnAriaSort(
  current: InventorySort,
  field: InventorySortField,
): 'ascending' | 'descending' | 'none' {
  if (current.field !== field) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}
