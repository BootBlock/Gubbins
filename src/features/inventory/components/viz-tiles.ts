/**
 * Shared tile styling for the two whole-collection inventory visualisations (the location map and
 * the value treemap). Both paint tiles from the app's semantic **location colour** palette
 * (`--loc-*`, the design system's categorical theme) rather than any ad-hoc chart colours, so the
 * views stay themable and dark-mode-correct like everything else.
 *
 * Colour is applied as a **faint wash** behind the tile with the tile's title in the matching
 * `text-loc-*` ink. That keeps body text at full `text-foreground` contrast in both themes, and —
 * crucially — means identity is never carried by colour alone: every tile is directly labelled, and
 * its coloured title reinforces (rather than replaces) that label (WCAG 1.4.1). Hues are assigned by
 * a stable hash of the entity's id, so a tile's colour follows the entity, never its rank.
 *
 * The class strings are hand-written **static literals** below so Tailwind's scanner emits the
 * utilities — a computed `` `bg-loc-${key}/25` `` would never be seen (unknown utilities fail
 * silently). `LOCATION_COLORS` is the single source of the palette; this only adds the washed
 * variant the tiles need.
 */
import { LOCATION_COLORS, locationColorTextClass, type LocationColor } from '../location-color';

/** The washed background utility (25% of the swatch, composited over the surface) per swatch key. */
const TILE_WASH: Record<LocationColor, string> = {
  rose: 'bg-loc-rose/25',
  orange: 'bg-loc-orange/25',
  amber: 'bg-loc-amber/25',
  lime: 'bg-loc-lime/25',
  green: 'bg-loc-green/25',
  teal: 'bg-loc-teal/25',
  cyan: 'bg-loc-cyan/25',
  blue: 'bg-loc-blue/25',
  violet: 'bg-loc-violet/25',
  fuchsia: 'bg-loc-fuchsia/25',
  pink: 'bg-loc-pink/25',
  slate: 'bg-loc-slate/25',
};

/**
 * A stable swatch for an arbitrary entity id (a category or location id), hashed into the palette
 * so the same entity always gets the same hue regardless of its neighbours or its rank in the
 * chart. A short, deterministic string hash — collisions across many entities are cosmetically
 * harmless because every tile is directly labelled.
 */
export function hueForId(id: string): LocationColor {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % LOCATION_COLORS.length;
  return LOCATION_COLORS[index]!;
}

/** The classes for a coloured tile: `{ wash, text }`. Prefers an explicit swatch, else hashes `id`. */
export interface TileClasses {
  /** Background wash utility (a faint fill of the swatch). */
  readonly wash: string;
  /** Matching title-ink utility (`text-loc-*`), readable on the wash and the base surface alike. */
  readonly text: string;
}

/**
 * Resolve the wash + title classes for a tile. Pass the entity's own colour swatch (a location's
 * `color`) when it has one — the tile then matches the rest of the app; otherwise a hue is hashed
 * from `id` so every tile still has a stable identity colour. `id` of `null` (the "ungrouped"
 * bucket) returns a neutral, colourless tile.
 */
export function tileClasses(id: string | null, color?: string | null): TileClasses {
  if (id === null) {
    return { wash: 'bg-muted/40', text: 'text-muted-foreground' };
  }
  const swatch =
    color && (LOCATION_COLORS as readonly string[]).includes(color) ? (color as LocationColor) : hueForId(id);
  return { wash: TILE_WASH[swatch], text: locationColorTextClass(swatch) ?? 'text-foreground' };
}
