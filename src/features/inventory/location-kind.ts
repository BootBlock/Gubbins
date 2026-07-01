/**
 * Location types (the "kind" metadata). A user may tag a location with one of a fixed
 * set of physical types; the choice is stored as a semantic *key* (not a label or icon
 * reference) and mapped to a human label here and to a lucide glyph in the
 * {@link LocationKindIcon} component (React lives there, not in this pure module — see
 * the Phase-42 `.ts`/`.tsx` basename-collision note). A null/unknown key means "no
 * specific type": the generic folder icon is used.
 *
 * This mirrors the shape of {@link file://./location-color.ts} so the picker, tree and
 * dialogs treat colour and type identically.
 */

export const LOCATION_KINDS = [
  'building',
  'room',
  'cabinet',
  'shelf',
  'drawer',
  'bin',
  'box',
  'bag',
  'vehicle',
  'other',
] as const;

export type LocationKind = (typeof LOCATION_KINDS)[number];

const LABEL: Record<LocationKind, string> = {
  building: 'Building',
  room: 'Room',
  cabinet: 'Cabinet',
  shelf: 'Shelf',
  drawer: 'Drawer',
  bin: 'Bin',
  box: 'Box',
  bag: 'Bag',
  vehicle: 'Vehicle',
  other: 'Other',
};

/** Narrow an arbitrary stored value to a known type key. */
export function isLocationKind(value: string | null | undefined): value is LocationKind {
  return value != null && (LOCATION_KINDS as readonly string[]).includes(value);
}

/** A human-readable label for a type key, or `undefined` for none/an unknown key. */
export function locationKindLabel(value: string | null | undefined): string | undefined {
  return isLocationKind(value) ? LABEL[value] : undefined;
}
