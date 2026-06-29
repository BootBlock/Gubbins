/**
 * Location colour swatches (spec §4). A user may tint a location with one of a fixed
 * pastel palette; the choice is stored as a semantic *key* (not a raw colour) and
 * mapped here to the themed `text-loc-*` / `bg-loc-*` design tokens defined in
 * `styles/index.css` (dark- and light-mode correct in one place). An unknown or null
 * key means "no colour" — the standard text colour is used.
 *
 * The class strings are written as **static literals** in the maps below so Tailwind's
 * scanner generates the utilities (a computed `` `text-loc-${key}` `` would not be seen).
 */

export const LOCATION_COLORS = [
  'rose',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'violet',
  'fuchsia',
  'pink',
  'slate',
] as const;

export type LocationColor = (typeof LOCATION_COLORS)[number];

const TEXT_CLASS: Record<LocationColor, string> = {
  rose: 'text-loc-rose',
  orange: 'text-loc-orange',
  amber: 'text-loc-amber',
  lime: 'text-loc-lime',
  green: 'text-loc-green',
  teal: 'text-loc-teal',
  cyan: 'text-loc-cyan',
  blue: 'text-loc-blue',
  violet: 'text-loc-violet',
  fuchsia: 'text-loc-fuchsia',
  pink: 'text-loc-pink',
  slate: 'text-loc-slate',
};

const BG_CLASS: Record<LocationColor, string> = {
  rose: 'bg-loc-rose',
  orange: 'bg-loc-orange',
  amber: 'bg-loc-amber',
  lime: 'bg-loc-lime',
  green: 'bg-loc-green',
  teal: 'bg-loc-teal',
  cyan: 'bg-loc-cyan',
  blue: 'bg-loc-blue',
  violet: 'bg-loc-violet',
  fuchsia: 'bg-loc-fuchsia',
  pink: 'bg-loc-pink',
  slate: 'bg-loc-slate',
};

const LABEL: Record<LocationColor, string> = {
  rose: 'Rose',
  orange: 'Orange',
  amber: 'Amber',
  lime: 'Lime',
  green: 'Green',
  teal: 'Teal',
  cyan: 'Cyan',
  blue: 'Blue',
  violet: 'Violet',
  fuchsia: 'Fuchsia',
  pink: 'Pink',
  slate: 'Slate',
};

/** Narrow an arbitrary stored value to a known swatch key. */
export function isLocationColor(value: string | null | undefined): value is LocationColor {
  return value != null && (LOCATION_COLORS as readonly string[]).includes(value);
}

/**
 * The Tailwind text-colour utility for a stored colour key, or `undefined` for none /
 * an unrecognised key (so the caller falls back to the standard text colour).
 */
export function locationColorTextClass(value: string | null | undefined): string | undefined {
  return isLocationColor(value) ? TEXT_CLASS[value] : undefined;
}

/** The background-fill utility for a swatch chip in the picker. */
export function locationColorSwatchClass(color: LocationColor): string {
  return BG_CLASS[color];
}

/** A human-readable label for a swatch (used as the picker's accessible name). */
export function locationColorLabel(color: LocationColor): string {
  return LABEL[color];
}
