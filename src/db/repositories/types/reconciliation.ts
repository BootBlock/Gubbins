/**
 * Cycle-count, serialised-audit, and external-scrape adjustment inputs
 * (spec §4.4, §4, §9). Each carries a decision computed upstream by a pure engine;
 * the repository trusts these and applies them atomically with a ledger entry.
 */
import type { BatchIdentity } from '@/features/inventory/batches';

/**
 * One authorised Reconciliation Adjustment (§4.4). The upstream cycle-count session
 * computes the variance and the ledger note from the blind count; the repository
 * trusts these and atomically sets the new on-hand quantity, recording a
 * `RECONCILED` history entry — mirroring how `applyScrape` consumes an upstream
 * merge decision.
 */
export interface ReconciliationAdjustment {
  readonly itemId: string;
  /** The physically counted quantity that becomes the new on-hand amount. */
  readonly counted: number;
  /** The §4.4 ledger note (built upstream from the location + variance). */
  readonly note: string;
  /**
   * The specific placement counted (Phase 26): when set, the variance is absorbed at
   * *this* location's `item_stock` row and `counted` becomes that placement's new
   * quantity. When omitted, the legacy whole-item behaviour applies — the variance lands
   * on the item's primary location and `counted` is the new on-hand *total*.
   */
  readonly locationId?: string;
  /**
   * The specific batch counted within the placement (Phase 28): when set (alongside
   * `locationId`), `counted` becomes *that lot's* new quantity at the placement and the
   * variance is absorbed at its `stock_batches` row, so a single drawer's lots can be
   * audited one at a time. The identity columns are written when the batch row is first
   * seeded by a surplus. When omitted, the count is whole-placement (absorbed at the
   * untracked default batch / drawn down FEFO).
   */
  readonly batch?: BatchIdentity;
}

/**
 * One authorised serialised-audit adjustment (§4.4). A SERIALISED instance is a
 * qty-1 record, so an audit reconciles **presence**, not quantity: an instance the
 * auditor could not find is reported here and the repository soft-deletes it
 * (reversible via `restore`), logging a `RECONCILED` entry. Only the missing
 * instances are passed — the present/missing decision happens upstream.
 */
export interface SerialisedReconciliation {
  readonly itemId: string;
  /** The §4.4 ledger note (built upstream from the location + serial number). */
  readonly note: string;
}

/**
 * The resolved writes of an external-scrape merge (spec §4, §9). Only the fields
 * the merge engine decided to apply are present — the §4 no-overwrite decision
 * happens upstream in the pure merge engine — plus any supplier MPNs to map in as
 * new aliases. Structurally compatible with the scraping feature's `ScrapeWrite`.
 */
export interface ScrapeApplyInput {
  readonly fields: {
    readonly mpn?: string;
    readonly manufacturer?: string;
    readonly description?: string;
    readonly unitCost?: number;
  };
  readonly aliasAdditions: readonly string[];
}
