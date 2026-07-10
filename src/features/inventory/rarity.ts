/**
 * Item "rarity" — the pure seam behind the **Collector cards** gamification (Settings →
 * Appearance). Purely decorative: when the toggle is on (and the maximal "I have a headache"
 * animation level is active), each inventory card is dressed like a collectible trading card,
 * with a rarity tier drawn from how valuable its stock is. It never changes any real data,
 * feeds no report, and is redundant with the item's own priced value — so it stays within
 * WCAG 1.4.1 (colour is never the sole signal; the tier also carries a word).
 *
 * The tier is a bounded, deterministic function of the item's *collection value* — the best
 * per-unit value it has (a manual current/market value if set, else its replacement unit cost)
 * multiplied by the on-hand quantity, mirroring the Visual card's "total value" hero. Higher
 * value ⇒ rarer, exactly the trading-card metaphor ("this pile is worth a lot ⇒ it's rare").
 * The thresholds are deliberately coarse and expressed in the base currency (no conversion —
 * the same raw numbers the app shows), and live here as the single source of truth so the CSS
 * frame, the badge and any tests all read one definition.
 */
import type { Item } from '@/db/repositories';

/**
 * The five rarity tiers, ordered least → most rare (index === rank). `minValue` is the inclusive
 * collection-value floor at which an item reaches this tier, in the base currency; `common` starts
 * at 0 so every item has a tier. Each id maps to a `--rarity-<id>` token (light + dark) in
 * `styles/index.css` and a `[data-rarity='<id>']` block that points `--rarity` at it.
 */
export const RARITY_TIERS = [
  { id: 'common', label: 'Common', minValue: 0 },
  { id: 'uncommon', label: 'Uncommon', minValue: 25 },
  { id: 'rare', label: 'Rare', minValue: 100 },
  { id: 'epic', label: 'Epic', minValue: 500 },
  { id: 'legendary', label: 'Legendary', minValue: 2000 },
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
 * An item's **collection value** in the base currency: its best per-unit value (a manual
 * current/market value if one is set, else the replacement unit cost) times the on-hand quantity.
 * An unlimited-supply item ignores its (meaningless) quantity and is valued per single unit.
 * Returns 0 when the item is unpriced, so an unpriced item is always `common`. Never negative.
 */
export function itemCollectionValue(item: Item): number {
  const perUnit = item.currentValue ?? item.unitCost ?? 0;
  if (!Number.isFinite(perUnit) || perUnit <= 0) return 0;
  const qty = item.isUnlimited ? 1 : Math.max(item.quantity, 0);
  return perUnit * qty;
}

/**
 * The rarity tier an item falls into — the highest tier whose {@link RARITY_TIERS} `minValue`
 * floor its {@link itemCollectionValue} meets. Pure and total: an unpriced/zero-value item is
 * always `common`.
 */
export function itemRarity(item: Item): Rarity {
  const value = itemCollectionValue(item);
  // Tiers ascend by minValue, so the last one whose floor the value clears is the highest it reaches.
  let tier: Rarity = 'common';
  for (const t of RARITY_TIERS) {
    if (value >= t.minValue) tier = t.id;
  }
  return tier;
}
