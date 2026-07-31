/**
 * Pure "Visual-card hero metric" resolution (issue #107 — a fallback for the hero slot).
 *
 * The Visual card's hero slot for a plain DISCRETE item shows one user-chosen signal (its
 * `VisualCardMetric`: stock health, total value, last updated, condition or manufacturer).
 * Some of those have nothing to show for a given item — an unpriced item under "Total value",
 * an item with no condition, or no manufacturer set. This seam decides *which* metric a card
 * actually renders: the chosen primary when it has content, else the user's fallback when
 * that does, else the primary again (so it draws its own muted placeholder).
 *
 * Side-effect-free and `Item`-dependent, mirroring the sibling `card-badge.ts` seam (which
 * resolves the top-right badge the same way): the store persists the two chosen ids and this
 * resolves them against one item into the metric id the {@link DiscreteCardMetric} draws. No
 * React, no DB — exhaustively unit-testable.
 */
import { assertExhaustive } from '@/lib/exhaustive';
import type { Item } from '@/db/repositories';
import type { VisualCardMetric, VisualCardMetricFallback } from '@/features/settings/settings';
import { itemTotalValue } from './item-total-value';

/** Whether a string field carries printable (non-whitespace) text. */
function hasText(value: string | null): boolean {
  return value != null && value.trim() !== '';
}

/**
 * Whether `metric` has genuine content to show for `item` — the test that decides whether the
 * fallback kicks in. `stockHealth` and `lastUpdated` are always available (every item has a
 * reorder-derived band and an updated-at instant); the others depend on the item:
 * - `value` — an item with a meaningful total ({@link itemTotalValue}, shared with the `value`
 *   card field and badge): priced, not an unlimited source, and for a gauge priced per unit of
 *   measure rather than per unit (issue #683).
 * - `condition` — a tracked condition is set.
 * - `manufacturer` — a manufacturer/brand is recorded.
 *
 * @internal Exported for unit tests only.
 */
export function metricHasContent(metric: VisualCardMetric, item: Item): boolean {
  switch (metric) {
    case 'stockHealth':
    case 'lastUpdated':
      return true;
    case 'value':
      return itemTotalValue(item) !== null;
    case 'condition':
      return item.condition != null;
    case 'manufacturer':
      return hasText(item.manufacturer);
    default:
      // Exhaustiveness guard (#355): a new VisualCardMetric must extend this switch or this
      // stops compiling. Reporting "no content" for an unknown metric hands the card over to
      // the fallback rather than claiming a signal it cannot draw.
      assertExhaustive(metric);
      return false;
  }
}

/**
 * The metric a card actually renders for `item`: the chosen `primary` when it has content,
 * else the `fallback` when that does, else the `primary` again (which draws its own muted
 * placeholder). So "Manufacturer" + "Stock health" shows the maker where one is set and the
 * reorder status everywhere else; the default (`primary` + `none`) always returns `primary`,
 * exactly the pre-issue-#107 behaviour.
 */
export function resolveVisualCardMetric(
  item: Item,
  primary: VisualCardMetric,
  fallback: VisualCardMetricFallback,
): VisualCardMetric {
  if (metricHasContent(primary, item)) return primary;
  if (fallback !== 'none' && metricHasContent(fallback, item)) return fallback;
  return primary;
}
