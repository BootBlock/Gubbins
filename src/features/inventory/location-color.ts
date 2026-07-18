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

/**
 * The SVG paint classes for a location-photo **region** outlined in its location's swatch
 * (issue #81). `stroke-*` and `fill-*` are ordinary Tailwind colour utilities — the same
 * `--color-loc-*` aliases behind `text-loc-*` / `bg-loc-*` drive them — so a tinted region
 * reuses this palette rather than forking a parallel one. Written as static literals for the
 * scanner, exactly as the maps above are. The fill is translucent via the shape's
 * `fill-opacity` attribute (a number, not a colour) so the photo still reads through it.
 */
const STROKE_CLASS: Record<LocationColor, string> = {
  rose: 'stroke-loc-rose fill-loc-rose',
  orange: 'stroke-loc-orange fill-loc-orange',
  amber: 'stroke-loc-amber fill-loc-amber',
  lime: 'stroke-loc-lime fill-loc-lime',
  green: 'stroke-loc-green fill-loc-green',
  teal: 'stroke-loc-teal fill-loc-teal',
  cyan: 'stroke-loc-cyan fill-loc-cyan',
  blue: 'stroke-loc-blue fill-loc-blue',
  violet: 'stroke-loc-violet fill-loc-violet',
  fuchsia: 'stroke-loc-fuchsia fill-loc-fuchsia',
  pink: 'stroke-loc-pink fill-loc-pink',
  slate: 'stroke-loc-slate fill-loc-slate',
};

/**
 * The paired classes that paint an inventory card/row with its location's accent tint
 * (visual-flair F10): the shared `gubbins-loc-tint` behaviour class plus a `.loc-tint-*`
 * class that sets the `--loc-tint` custom property to this location's `--loc-*` swatch
 * token. Both are hand-authored rules in `styles/index.css` (not Tailwind utilities), so
 * — unlike the `text-loc-*` / `bg-loc-*` maps above — they need no static-literal scan and
 * reuse the exact same swatch palette rather than forking a second location→colour scheme.
 */
const TINT_CLASS: Record<LocationColor, string> = {
  rose: 'gubbins-loc-tint loc-tint-rose',
  orange: 'gubbins-loc-tint loc-tint-orange',
  amber: 'gubbins-loc-tint loc-tint-amber',
  lime: 'gubbins-loc-tint loc-tint-lime',
  green: 'gubbins-loc-tint loc-tint-green',
  teal: 'gubbins-loc-tint loc-tint-teal',
  cyan: 'gubbins-loc-tint loc-tint-cyan',
  blue: 'gubbins-loc-tint loc-tint-blue',
  violet: 'gubbins-loc-tint loc-tint-violet',
  fuchsia: 'gubbins-loc-tint loc-tint-fuchsia',
  pink: 'gubbins-loc-tint loc-tint-pink',
  slate: 'gubbins-loc-tint loc-tint-slate',
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

/**
 * The class string that gives a card/row a faint left-edge accent tint in this location's
 * swatch (visual-flair F10), or `undefined` for none / an unrecognised key (so an unassigned
 * or uncoloured location's items stay a neutral card). Purely decorative — the location name
 * still renders in its {@link locationColorTextClass} tint, so colour is never the sole cue.
 */
export function locationColorTintClass(value: string | null | undefined): string | undefined {
  return isLocationColor(value) ? TINT_CLASS[value] : undefined;
}

/**
 * The SVG `stroke-*` + `fill-*` utilities for a region outlined in this location's swatch, or
 * `undefined` for none / an unrecognised key — in which case the caller falls back to the
 * untinted `--shape-*` overlay tokens.
 */
export function locationColorStrokeClass(value: string | null | undefined): string | undefined {
  return isLocationColor(value) ? STROKE_CLASS[value] : undefined;
}

/** The background-fill utility for a swatch chip in the picker. */
export function locationColorSwatchClass(color: LocationColor): string {
  return BG_CLASS[color];
}

/** A human-readable label for a swatch (used as the picker's accessible name). */
export function locationColorLabel(color: LocationColor): string {
  return LABEL[color];
}
