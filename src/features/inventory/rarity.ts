/**
 * Item "rarity" — the pure seam behind the **Collector cards** gamification (Settings →
 * Appearance). Purely decorative: when the toggle is on (and the maximal "Total Gubbage"
 * animation level is active), a *lucky few* inventory cards are dressed like a collectible trading
 * card, with a rarity gem and a tinted frame. It never changes any real data and feeds no report.
 *
 * **Only ~5% of items are collectors.** Which ones is a deterministic function of the item's name
 * (a stable string hash), so a given item is always — or never — a collector, independent of its
 * value, stock or edits. The same hash also picks the tier, weighted so the showier tiers are the
 * rarer finds (most collectors are Common; a Legendary is roughly 1 in 700 items overall). A
 * non-collector returns `null` — no frame, no badge.
 *
 * Basing it on the name (not value/quantity) keeps it a fun, stable collectible attribute rather
 * than a running commentary on how much stock is worth, and means it never churns as stock moves.
 */
import type { Item } from '@/db/repositories';

/**
 * The five rarity tiers, ordered least → most rare (index === rank). Each id maps to a
 * `--rarity-<id>` token (light + dark) in `styles/index.css` and a `[data-rarity='<id>']` block
 * that points `--rarity` at it.
 */
export const RARITY_TIERS = [
  { id: 'common', label: 'Common' },
  { id: 'uncommon', label: 'Uncommon' },
  { id: 'rare', label: 'Rare' },
  { id: 'epic', label: 'Epic' },
  { id: 'legendary', label: 'Legendary' },
] as const;

/** A rarity tier id. */
export type Rarity = (typeof RARITY_TIERS)[number]['id'];

/** Every rarity id, least → most rare (index === rank), for iteration / validation. */
export const RARITY_IDS = RARITY_TIERS.map((t) => t.id) as Rarity[];

/** A tier's display label (e.g. `'Legendary'`). */
export const RARITY_LABELS: Record<Rarity, string> = Object.fromEntries(
  RARITY_TIERS.map((t) => [t.id, t.label]),
) as Record<Rarity, string>;

/**
 * Fraction of items that are collector cards (~5%). An item is a collector when its normalised
 * name hash falls below this threshold.
 */
export const COLLECTOR_FRACTION = 0.05;

/**
 * Cumulative tier bands *within* the collector population, least → most rare. A collector's
 * position in the [0, {@link COLLECTOR_FRACTION}) band (rescaled to [0, 1)) is matched against
 * these upper bounds, so ~50% of collectors are Common down to ~2% Legendary (≈0.1% of all
 * items). The last band is implicitly 1.0.
 */
const TIER_BANDS: readonly { readonly id: Rarity; readonly max: number }[] = [
  { id: 'common', max: 0.5 },
  { id: 'uncommon', max: 0.78 },
  { id: 'rare', max: 0.92 },
  { id: 'epic', max: 0.98 },
  { id: 'legendary', max: 1 },
];

/**
 * A stable 32-bit unsigned hash of a string (FNV-1a). Deterministic and dependency-free; used only
 * to decide the decorative collector status, so it needs to distribute, not to be cryptographic.
 */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The rarity tier an item is a collector for, or `null` when it is an ordinary (non-collector)
 * item — the ~95% case. Pure and deterministic from the item's name: the same name always yields
 * the same result. See the module header for the distribution.
 */
export function itemRarity(item: Item): Rarity | null {
  // Normalise the hash to [0, 1). The collector gate takes the bottom COLLECTOR_FRACTION of that
  // space; a collector's position within it (rescaled to [0, 1)) then selects the tier band — one
  // deterministic value driving both, so status and tier never disagree.
  const h = hashName(item.name) / 0x1_0000_0000;
  if (h >= COLLECTOR_FRACTION) return null;
  const withinBand = h / COLLECTOR_FRACTION; // [0, 1) across the collector population
  for (const band of TIER_BANDS) {
    if (withinBand < band.max) return band.id;
  }
  return 'legendary';
}
