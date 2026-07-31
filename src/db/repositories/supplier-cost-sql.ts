/**
 * The **base-currency guard** and the **preferred-supplier cost lookup** used wherever a supplier
 * price becomes a figure denominated in the user's own currency — the valuation reads, the
 * insurance schedule, and the sale/write-off cost snapshot.
 *
 * They live here rather than in {@link file://./ReportRepository.ts} because the reporting screens
 * are not the only consumer: a sale or a write-off snapshots the same cost into the `item_history`
 * ledger (`item/stock.ts`), and that snapshot is *permanent* — the ledger is append-only, so a row
 * written with the wrong cost can never be corrected. Issue #687 was exactly that divergence: the
 * sale path spelled the subquery out again, without the currency guard, and booked a ¥9,800 part as
 * £9,800 of cost-of-goods. One definition, imported by both, is what stops the next reader of
 * `supplier_parts.unit_cost` from re-deriving it and dropping a predicate on the way.
 */

/**
 * SQL predicate matching a currency column denominated in the user's base currency, and therefore
 * summable into a total (issue #284; extended to purchase orders by issue #285).
 *
 * A `currency` — on a supplier part or on a purchase order — is free ISO-4217 text the user sets,
 * and it is stored and shown **verbatim — never converted**, because Gubbins holds no exchange
 * rates (no rate column, no rate-capture timestamp, nothing). Adding a ¥9,800 part to a £ total as
 * "9800" is not an approximation, it is a wrong number — and on the insurance schedule it is a
 * wrong number in a document a user may hand to an insurer. So a foreign-currency price is
 * excluded from valuation rather than silently mis-summed, mirroring the same refusal
 * `price-refresh` already makes when asked for the cheapest of mixed-currency quotes.
 *
 * `NULL`/blank means "base currency" (the columns' documented convention), so those always
 * match — blank is tested after `TRIM`, since a whitespace-only code names no currency and can
 * reach the column through a sync merge or an import, neither of which trims the way the entry
 * dialogs do. `baseCurrency` is null when unknown, which disables the filter entirely — an
 * unknown base cannot tell foreign from domestic, and failing open preserves the previous
 * behaviour rather than blanking every total.
 *
 * `col` is the qualified currency column to test (`sp.currency`, `po.currency`); passing one the
 * enclosing query does not expose fails loudly as an unknown-column error rather than quietly
 * matching nothing.
 */
export function inBaseCurrencySql(col: string, baseCurrency: string): string {
  // `baseCurrency` is normalised to three ASCII letters by `BaseRepository.baseCurrency()`,
  // so this interpolation carries no quoting or injection surface.
  return `(${col} IS NULL OR TRIM(${col}) = '' OR UPPER(TRIM(${col})) = '${baseCurrency}')`;
}

/**
 * Correlated subquery yielding the **preferred** supplier part's `unit_cost` for an item
 * (NULL when none is marked, the preferred row is unpriced, or its price is in a currency
 * other than the base — see {@link inBaseCurrencySql}). Feeds the `preferredSupplierCost`
 * fallback so valuation honours the Phase-60 cost precedence — a manual `items.unit_cost` wins,
 * else the preferred supplier cost — resolved in one place by `effectiveUnitCost`
 * (`@/features/reports/reports`, and its `@/features/inventory/supplier-cost` twin on the sale
 * path). `col` is the qualified item-id column to correlate on. At most one preferred row exists
 * per item — the repository's demote-then-set write, backstopped by the partial unique index
 * `idx_supplier_parts_one_preferred` (issues #157/#192) — so the `ORDER BY` is a defensive
 * tiebreak for a state the schema already forbids, not a rule anything relies on.
 *
 * A declined price yields NULL rather than 0: "unpriced" and "worth nothing" are different facts,
 * and every consumer already distinguishes them — valuation counts the item as unpriced and
 * `ReportRepository.foreignCurrencyCostCount` surfaces how many were left out, while a sale writes
 * no `unitCostAtSale` and the sales report tallies the units in `unitsWithoutCost` so the margin is
 * caveated rather than overstated.
 */
export function preferredSupplierCostSql(col: string, baseCurrency: string | null): string {
  return `(SELECT sp.unit_cost FROM supplier_parts sp
             WHERE sp.item_id = ${col} AND sp.is_preferred = 1${
               baseCurrency === null ? '' : ` AND ${inBaseCurrencySql('sp.currency', baseCurrency)}`
             }
             ORDER BY sp.updated_at DESC LIMIT 1)`;
}
