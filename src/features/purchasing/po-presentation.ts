/**
 * Pure presentation helpers for the Purchase Orders UI (Inventory-depth Phase 62).
 *
 * Maps a PO status to a British-English label and a **design token** class (never a raw
 * colour) so the badge styling lives in one tested place. Kept dependency-free (no React)
 * per the pure-.ts-seam split.
 */
import type { PurchaseOrderStatus } from '@/db/repositories';
import { MONEY_DECIMALS, sumMoney } from '@/lib/money';

export interface PoStatusPresentation {
  readonly label: string;
  /** A `text-glyph-*` token class for the badge glyph/text (CLAUDE.md: tokens only). */
  readonly toneClass: string;
}

const PRESENTATION: Record<PurchaseOrderStatus, PoStatusPresentation> = {
  DRAFT: { label: 'Draft', toneClass: 'text-glyph-neutral' },
  ORDERED: { label: 'Ordered', toneClass: 'text-glyph-checkout' },
  PARTIAL: { label: 'Partially received', toneClass: 'text-glyph-gauge' },
  RECEIVED: { label: 'Received', toneClass: 'text-glyph-success' },
  CANCELLED: { label: 'Cancelled', toneClass: 'text-glyph-danger' },
};

/** The label + token tone for a PO status. */
export function poStatusPresentation(status: PurchaseOrderStatus): PoStatusPresentation {
  return PRESENTATION[status];
}

/** Total ordered units across a set of lines. */
export function totalOrdered(lines: readonly { orderedQty: number }[]): number {
  return lines.reduce((sum, l) => sum + Math.max(0, l.orderedQty), 0);
}

/** Total received units across a set of lines. */
export function totalReceived(lines: readonly { receivedQty: number }[]): number {
  return lines.reduce((sum, l) => sum + Math.max(0, l.receivedQty), 0);
}

/**
 * Estimated order value across a set of lines (ordered qty × unit cost where priced).
 *
 * Lines extend at full precision and the **total** is quantised once (issue #288), so the figure
 * shown against an order matches what its lines actually come to rather than carrying float drift.
 *
 * @param decimals How many places to quantise that total to — the *currency's* minor unit, not a
 * flat two (issue #292). An order priced in yen has no sub-unit at all, so a 2dp total advertises
 * a half-yen the order cannot be placed for; one priced in Bahraini dinars is written to three, and
 * a 2dp total would silently drop a fils per order. Callers pass
 * `useFormatters().currencyFractionDigits()`; the default keeps the pre-#292 behaviour.
 */
export function estimatedValue(
  lines: readonly { orderedQty: number; unitCost: number | null }[],
  decimals: number = MONEY_DECIMALS,
): number {
  return sumMoney(
    lines.map((l) => (l.unitCost != null ? Math.max(0, l.orderedQty) * l.unitCost : 0)),
    decimals,
  );
}

/**
 * Normalise a stored ISO currency code to compare it: trimmed and upper-cased, with blank and
 * `null` alike collapsing to `null`. `null` is the "base currency" convention both
 * `purchase_orders.currency` and `supplier_parts.currency` document, and a whitespace-only code
 * names no currency either — a distinction the SQL side makes the same way (issue #285).
 */
export function normaliseCurrencyCode(code: string | null | undefined): string | null {
  const trimmed = (code ?? '').trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Whether a supplier's quote is denominated differently from the order it would be added to
 * (issue #285).
 *
 * A purchase-order line stores a bare number whose currency is the **order's** — so copying a
 * supplier's €12.00 into a GBP order records "12.00 GBP", a wrong figure by the exchange rate,
 * and Gubbins holds no rates to convert with. Both sides resolve their blank-means-base
 * convention against `baseCurrency` first, so a EUR quote on an order with no code of its own is
 * correctly a mismatch (the order is in the base currency), and a blank quote against a blank
 * order is not.
 *
 * With an unknown base (`null`), only two *explicit* and differing codes can be judged a
 * mismatch: an unknown base cannot tell whether a blank means the same currency as a stated one,
 * and guessing would raise a false alarm on every line. This mirrors the repository's
 * fail-open-on-unknown-base rule.
 */
export function isCurrencyMismatch(
  supplierCurrency: string | null | undefined,
  orderCurrency: string | null | undefined,
  baseCurrency: string | null | undefined,
): boolean {
  const base = normaliseCurrencyCode(baseCurrency);
  const supplier = normaliseCurrencyCode(supplierCurrency) ?? base;
  const order = normaliseCurrencyCode(orderCurrency) ?? base;
  if (supplier === null || order === null) return false;
  return supplier !== order;
}
