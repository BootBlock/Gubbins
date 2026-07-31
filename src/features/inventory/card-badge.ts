/**
 * Pure "item-card badge slot" model (issue #117 — configurable top-right card badge).
 *
 * Every inventory item card/row carries one small badge in its top-right slot. Historically
 * that was always the tracking-mode pill (e.g. "# Bulk"); this seam lets the user choose what
 * that slot shows instead — the tracking mode, the item's unit price, its total stock value,
 * or its condition — plus a **fallback** for when the chosen content has nothing to show for a
 * given item (e.g. "Unit price" with a "Tracking" fallback shows the price where one is set,
 * and the tracking pill where it is not).
 *
 * Side-effect-free and `Item`-dependent, mirroring the sibling `card-fields.ts` seam: the
 * store persists the two chosen ids (the user's intent) and this resolves them against one
 * item into the token-agnostic descriptor the {@link import('./components/CardBadge').CardBadge}
 * component draws. No React, no DB — exhaustively unit-testable.
 */
import { assertExhaustive } from '@/lib/exhaustive';
import type { Item, TrackingMode } from '@/db/repositories';
import type { Condition } from '@/db/repositories/constants';
import { itemTotalValue } from './item-total-value';

/**
 * What an item card's top-right badge slot shows:
 * - `tracking` — the tracking-mode pill (Bulk / Serialised / Consumable / Untracked). The
 *   historic behaviour and the shipped default; available for every item.
 * - `unitPrice` — the item's singular unit cost, via the Money control. Available whenever a
 *   unit cost is set.
 * - `totalValue` — the item's combined stock value, via Money. Available whenever
 *   {@link itemTotalValue} yields one: a priced, non-unlimited item — a gauge counts, valued from
 *   its contents rather than a unit count (issue #683) — matching the `value` card field exactly.
 * - `condition` — the item's tracked condition (Mint / Good / …), tinted with its condition
 *   token. Available only when a condition is set.
 * - `none` — the slot is empty (nothing is drawn). As a *fallback*, "no fallback".
 */
export type CardBadgeContent = 'tracking' | 'unitPrice' | 'totalValue' | 'condition' | 'none';

/** The shipped default badge content — the tracking-mode pill (the historic behaviour). */
export const DEFAULT_CARD_BADGE_CONTENT: CardBadgeContent = 'tracking';

/** The shipped default fallback — none, so the default is exactly "always show tracking". */
export const DEFAULT_CARD_BADGE_FALLBACK: CardBadgeContent = 'none';

/**
 * Choices for the Settings badge pickers (primary content first-listed default, and the same
 * set is offered for the fallback). The SSOT for the option ids + labels and the normaliser.
 */
export const CARD_BADGE_OPTIONS = [
  { value: 'tracking', label: 'Tracking mode' },
  { value: 'unitPrice', label: 'Unit price' },
  { value: 'totalValue', label: 'Total value' },
  { value: 'condition', label: 'Condition' },
  { value: 'none', label: 'Nothing' },
] as const satisfies readonly { value: CardBadgeContent; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link CardBadgeContent}, falling back to
 * `fallback` (the primary default by default; pass {@link DEFAULT_CARD_BADGE_FALLBACK} for the
 * fallback preference). Kept total so a stale localStorage value from an older/newer build can
 * never reach the badge's render switch.
 */
export function normaliseCardBadgeContent(
  value: unknown,
  fallback: CardBadgeContent = DEFAULT_CARD_BADGE_CONTENT,
): CardBadgeContent {
  return typeof value === 'string' &&
    (CARD_BADGE_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)
    ? (value as CardBadgeContent)
    : fallback;
}

/**
 * A resolved badge, as a token-agnostic descriptor the card maps to JSX — kept out of this pure
 * seam so a money value keeps using the Foundry Money control and a condition keeps its
 * `text-cond-*` tint (design-token house rules) rather than a pre-formatted string. `none`
 * renders nothing (the slot is empty).
 */
export type ResolvedCardBadge =
  | { readonly kind: 'tracking'; readonly mode: TrackingMode }
  | { readonly kind: 'money'; readonly amount: number; readonly scope: 'unit' | 'total' }
  | { readonly kind: 'condition'; readonly condition: Condition }
  | { readonly kind: 'none' };

const NONE: ResolvedCardBadge = { kind: 'none' };

/** Whether an item carries a usable unit cost (set and finite). */
function isPriced(item: Item): boolean {
  return item.unitCost != null && Number.isFinite(item.unitCost);
}

/**
 * The badge one content id resolves to for `item`, or `null` when that content has nothing to
 * show for this item (an unpriced item for a price badge, an untracked-condition item for the
 * condition badge, or `none`). `null` is what makes the fallback kick in.
 */
function badgeFor(content: CardBadgeContent, item: Item): ResolvedCardBadge | null {
  switch (content) {
    case 'tracking':
      return { kind: 'tracking', mode: item.trackingMode };
    case 'unitPrice':
      return isPriced(item) ? { kind: 'money', amount: item.unitCost!, scope: 'unit' } : null;
    case 'totalValue': {
      // Shares {@link itemTotalValue} with the `value` card field, so the badge and the field on
      // the same card can never disagree: an unlimited or unpriced item has no meaningful total
      // (null → the fallback badge), and a gauge is valued from its contents (issue #683).
      const total = itemTotalValue(item);
      return total === null ? null : { kind: 'money', amount: total, scope: 'total' };
    }
    case 'condition':
      return item.condition != null ? { kind: 'condition', condition: item.condition } : null;
    case 'none':
      return null;
    default:
      // Exhaustiveness guard (#355): a new CardBadgeContent must extend this switch or this
      // stops compiling. `normaliseCardBadgeContent` keeps a stale persisted id out of here,
      // so falling through to "nothing to show" is the right degradation.
      assertExhaustive(content);
      return null;
  }
}

/**
 * Resolve one item's badge: the chosen `content` if it has something to show, else the
 * `fallback`, else nothing. So "Unit price" + "Tracking" shows the price on priced items and
 * the tracking pill on the rest; the default ("Tracking" + "none") always shows tracking.
 */
export function resolveCardBadge(
  item: Item,
  content: CardBadgeContent,
  fallback: CardBadgeContent,
): ResolvedCardBadge {
  return badgeFor(content, item) ?? badgeFor(fallback, item) ?? NONE;
}
