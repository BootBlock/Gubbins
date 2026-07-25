/**
 * Purchase-orders export (issue #132): serialise the order list to a downloadable file — an
 * order book to reconcile against invoices or hand to whoever does the accounts.
 *
 * One row per **order**, matching the screen's master list, with the lines folded into totals.
 * A per-line file would be a different document (and the place for it is a single order's detail
 * view, not the list).
 *
 * Pure — it maps {@link PurchaseOrderWithLines} rows onto the shared tabular column model and
 * hands them to the generic serialisers in `@/features/export/tabular-export`. Kept free of
 * React and repositories.
 */
import type { PurchaseOrderWithLines } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { moneyDecimals } from '@/lib/money';
import { estimatedValue, poStatusPresentation } from './po-presentation';

/** Total ordered units across an order's lines. */
function orderedQty(po: PurchaseOrderWithLines): number {
  return po.lines.reduce((n, line) => n + line.orderedQty, 0);
}

/** Total received units across an order's lines. */
function receivedQty(po: PurchaseOrderWithLines): number {
  return po.lines.reduce((n, line) => n + line.receivedQty, 0);
}

/**
 * The export columns — the master row's identity, status and value, plus the line totals the
 * row summarises.
 *
 * The status is the **effective** one the row badges (derived from the lines), not the stored
 * snapshot, so a partially-received order reads "Partially received" in the file exactly as it
 * does on screen.
 *
 * `Total` is quantised to the order's *own* currency minor unit, not a flat 2dp (issue #292): a
 * line cost was copied verbatim from the supplier's quote and is never converted, so a yen-quoted
 * order totals in whole yen even under a sterling base. A **null** currency is the stored "this
 * order is in the base currency" convention, so it quantises to `baseDecimals` — passing it
 * through `moneyDecimals(null)` would silently fall back to 2, which under a 0dp base (JPY) puts
 * a half-yen in the file, and under a 3dp base (BHD) drops a fils. `baseDecimals` is injected
 * rather than read from a store so this module stays pure and the figure matches the one the
 * screen rendered. The adjacent `Currency` column names which currency the figure is in — blank
 * meaning the base currency — and the value stays a raw number for the reader's spreadsheet.
 *
 * @internal Exported for unit tests only.
 */
export function poExportColumns(baseDecimals: number): readonly TabularColumn<PurchaseOrderWithLines>[] {
  return [
    { header: 'Reference', value: (po) => po.reference },
    { header: 'Supplier', value: (po) => po.supplierName },
    { header: 'Status', value: (po) => poStatusPresentation(po.effectiveStatus).label },
    { header: 'Lines', value: (po) => po.lines.length },
    { header: 'Ordered qty', value: (po) => orderedQty(po) },
    { header: 'Received qty', value: (po) => receivedQty(po) },
    { header: 'Currency', value: (po) => po.currency },
    {
      header: 'Total',
      value: (po) => estimatedValue(po.lines, po.currency ? moneyDecimals(po.currency) : baseDecimals),
    },
    { header: 'Created', value: (po): TabularCell => isoTimestamp(po.createdAt) },
    { header: 'Ordered', value: (po): TabularCell => isoTimestamp(po.orderedAt) },
  ];
}

/**
 * Serialise the purchase-order list to the chosen format via the shared exporter.
 *
 * @param baseDecimals The base currency's minor unit, for orders stored without a currency of
 *   their own — the same figure the master list rows are rendered with.
 */
export function buildPurchaseOrdersExport(
  format: TabularExportFormat,
  orders: readonly PurchaseOrderWithLines[],
  baseDecimals: number,
): Promise<TabularExportResult> {
  return buildTabularExport(format, poExportColumns(baseDecimals), orders, {
    title: 'Purchase orders',
    caption: `${orders.length} order${orders.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the order list, e.g. `gubbins-purchase-orders-2026-07-25.csv`. */
export function purchaseOrdersExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('purchase-orders', extension, date);
}
