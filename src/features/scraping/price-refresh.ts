/**
 * Pure planning + summarisation for the item **price refresh** action (issue #28).
 *
 * Real-time pricing is already possible in Gubbins via the companion extension's §9 scrape:
 * a supplier part carries a product `url`, and a scrape of that URL returns `scraped_pricing`.
 * This module is the pure core of the one-click "refresh the price for this item's supplier(s)"
 * flow — it decides which supplier rows can be fetched (their URL is on a supported distributor
 * the extension may background-fetch) and which must be skipped, and once the scrapes settle it
 * summarises the outcomes: the **cheapest** live price and which supplier it came from.
 *
 * The caller (the button hook) chooses *which* suppliers to feed in: when the item has a pinned
 * price source it passes only that one (fetch just the source); otherwise it passes them all
 * (fetch every supplier, report the cheapest). This module stays agnostic of that choice.
 *
 * Framework-free (no React, no bridge) so it is exhaustively unit-tested; the hook that owns the
 * bridge turns a {@link RefreshPlan} into scrape requests and feeds the settled
 * {@link RefreshOutcome}s back through {@link summarisePriceRefresh}.
 */
import { isAllowedSupplierUrl } from './parsers/suppliers';
import type { ScrapeErrorType } from './protocol';

/** A supplier part reduced to what the refresh needs to plan against. */
export interface RefreshCandidate {
  readonly id: string;
  readonly supplierName: string;
  readonly url: string | null;
}

/** Why a supplier row could not be included in a refresh. */
export type SkipReason =
  /** The supplier row has no product URL to fetch. */
  | 'NO_URL'
  /** The URL is not on a distributor the extension can background-fetch (e.g. Amazon). */
  | 'UNSUPPORTED_URL';

/** A supplier row whose URL the extension may fetch for a live price. */
export interface FetchableSupplier {
  readonly id: string;
  readonly supplierName: string;
  readonly url: string;
}

/** A supplier row that cannot be refreshed, with the reason. */
export interface SkippedSupplier {
  readonly id: string;
  readonly supplierName: string;
  readonly reason: SkipReason;
}

/** The reviewable split of the candidate suppliers into fetchable vs skipped. */
export interface RefreshPlan {
  readonly fetchable: readonly FetchableSupplier[];
  readonly skipped: readonly SkippedSupplier[];
}

/**
 * Split candidate supplier rows into those whose price can be fetched and those that must be
 * skipped. A row is fetchable when it has a non-blank URL on a supported distributor domain
 * (the same allowlist the privileged background worker enforces, {@link isAllowedSupplierUrl}) —
 * so an Amazon URL (active-tab only) or a bare order code is skipped, never silently fetched.
 */
export function planPriceRefresh(candidates: readonly RefreshCandidate[]): RefreshPlan {
  const fetchable: FetchableSupplier[] = [];
  const skipped: SkippedSupplier[] = [];
  for (const c of candidates) {
    const url = c.url?.trim() ?? '';
    if (url.length === 0) {
      skipped.push({ id: c.id, supplierName: c.supplierName, reason: 'NO_URL' });
    } else if (!isAllowedSupplierUrl(url)) {
      skipped.push({ id: c.id, supplierName: c.supplierName, reason: 'UNSUPPORTED_URL' });
    } else {
      fetchable.push({ id: c.id, supplierName: c.supplierName, url });
    }
  }
  return { fetchable, skipped };
}

/** One fetched price, ready to compare and report. */
export interface RefreshPrice {
  /** The supplier part's id (so the caller can persist the new cost against it). */
  readonly id: string;
  readonly supplierName: string;
  readonly value: number;
  readonly currency: string;
}

/** A single fetchable supplier's settled scrape outcome. */
export type RefreshOutcome =
  | ({ readonly kind: 'PRICE' } & RefreshPrice)
  /** The scrape succeeded but the page carried no parseable price. */
  | { readonly kind: 'NO_PRICE'; readonly id: string; readonly supplierName: string }
  /** The scrape failed (transport / block / drift). */
  | {
      readonly kind: 'ERROR';
      readonly id: string;
      readonly supplierName: string;
      readonly errorType: ScrapeErrorType;
    };

/** The reportable result of a completed refresh run. */
export interface RefreshSummary {
  /** Every supplier that returned a live price, in the order they were requested. */
  readonly prices: readonly RefreshPrice[];
  /**
   * The cheapest price — but **only** when every fetched price shares one currency, so the
   * comparison is honest. Null when nothing priced, or when currencies are mixed (the caller
   * shows each price instead of pretending to compare across currencies).
   */
  readonly cheapest: RefreshPrice | null;
  /** True when the fetched prices span more than one currency (not directly comparable). */
  readonly mixedCurrencies: boolean;
  readonly priceCount: number;
  readonly noPriceCount: number;
  readonly errorCount: number;
}

/**
 * Summarise a refresh run's settled outcomes. Computes the cheapest live price (within a shared
 * currency — see {@link RefreshSummary.cheapest}), honouring the issue's "present the cheapest,
 * stating which supplier". Ties resolve to the first-requested supplier (deterministic).
 */
export function summarisePriceRefresh(outcomes: readonly RefreshOutcome[]): RefreshSummary {
  const prices: RefreshPrice[] = [];
  let noPriceCount = 0;
  let errorCount = 0;
  for (const o of outcomes) {
    if (o.kind === 'PRICE') {
      prices.push({ id: o.id, supplierName: o.supplierName, value: o.value, currency: o.currency });
    } else if (o.kind === 'NO_PRICE') {
      noPriceCount += 1;
    } else {
      errorCount += 1;
    }
  }

  const mixedCurrencies = new Set(prices.map((p) => p.currency)).size > 1;
  const cheapest =
    prices.length > 0 && !mixedCurrencies ? prices.reduce((min, p) => (p.value < min.value ? p : min)) : null;

  return {
    prices,
    cheapest,
    mixedCurrencies,
    priceCount: prices.length,
    noPriceCount,
    errorCount,
  };
}
