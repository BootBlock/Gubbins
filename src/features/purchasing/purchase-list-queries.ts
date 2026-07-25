/**
 * Write mutations for landing an imported purchase list (issue #34).
 *
 * One parse ({@link module:features/purchasing/purchase-list-import}) feeds three entry points:
 * add the lines to an existing purchase order, create a new draft order from them, or add them
 * to the wishlist. All three go through the *existing* repository write paths
 * (`PurchaseOrderRepository.create` / `.addLine`, `WishlistRepository.create`) — there is no
 * second way to write a PO line or a wishlist entry, so the validation, Hard-Stop gating and
 * sync conventions those paths own apply unchanged.
 *
 * Cache invalidation mirrors the single-row mutations in `queries.ts` / `wishlist-queries.ts`,
 * because a bulk import can change everything a one-line add can.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getItemRepository, getPurchaseOrderRepository, getWishlistRepository } from '@/db/repositories';
import { invalidateOnOrder, purchaseOrderKeys } from './queries';
import { wishlistKeys } from './wishlist-queries';
import {
  purchaseLineLabel,
  purchaseLineMatchKeys,
  toWishlistDraft,
  type ParsedPurchaseListLine,
} from './purchase-list-import';

/** What an import landed, for the confirmation summary. */
export interface PurchaseListImportSummary {
  /** How many lines/entries were written. */
  readonly added: number;
  /**
   * How many were auto-matched to a local item by MPN or supplier code. Always 0 for a
   * wishlist import — a wishlist entry deliberately references no item.
   */
  readonly matched: number;
  /** How many were skipped because they could not be written (e.g. a rejected wishlist entry). */
  readonly skipped: number;
}

/**
 * Resolve the local item a parsed line refers to, or `null`. Each candidate key (MPN, then the
 * supplier's code) is tried in turn and the first hit wins; a line with no identifiers never
 * touches the database.
 */
async function matchLocalItem(line: ParsedPurchaseListLine): Promise<string | null> {
  const items = getItemRepository();
  for (const key of purchaseLineMatchKeys(line)) {
    const match = await items.findByMatchKey(key);
    if (match) return match.id;
  }
  return null;
}

/**
 * Add parsed lines to an existing purchase order, auto-matching each to a local item. A matched
 * line links to the item (so receiving it moves that item's stock); an unmatched line stays a
 * manual row carrying just its description. The shared engine behind both PO entry points, so
 * "into this order" and "as a new order" match identically.
 */
async function importLinesInto(
  poId: string,
  lines: readonly ParsedPurchaseListLine[],
): Promise<PurchaseListImportSummary> {
  const orders = getPurchaseOrderRepository();
  let added = 0;
  let matched = 0;
  for (const line of lines) {
    const itemId = await matchLocalItem(line);
    if (itemId) matched += 1;
    await orders.addLine(poId, {
      itemId,
      description: purchaseLineLabel(line),
      orderedQty: line.quantity,
      ...(line.unitPrice !== null ? { unitCost: line.unitPrice } : {}),
    });
    added += 1;
  }
  return { added, matched, skipped: 0 };
}

/** Invalidate every cache a purchase-order write can affect. */
function invalidateOrders(client: QueryClient, poId?: string): void {
  void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
  if (poId) void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
  // Imported lines add to what is outstanding, which the agenda's reorder lane nets off its
  // shortfall — so the two prefixes move together, through the one helper (issue #374).
  invalidateOnOrder(client);
}

/** Import parsed lines into an existing purchase order. */
export function useImportPurchaseListIntoOrder(poId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (lines: readonly ParsedPurchaseListLine[]) => importLinesInto(poId, lines),
    onSettled: () => invalidateOrders(client, poId),
  });
}

/** The new order's id alongside the {@link PurchaseListImportSummary} for its imported lines. */
export interface CreateOrderFromListResult extends PurchaseListImportSummary {
  readonly poId: string;
}

/** Variables for {@link useCreateOrderFromPurchaseList}. */
export interface CreateOrderFromListVars {
  /**
   * The supplier as the user typed it on the import dialog. Passed to the repository as a
   * name rather than an id because an import is exactly the case where the supplier may not
   * exist yet; the repository resolves it onto the matching supplier or creates one.
   */
  readonly supplierName: string;
  readonly reference?: string;
  readonly lines: readonly ParsedPurchaseListLine[];
}

/**
 * Create a brand-new DRAFT purchase order from an imported list: the order is created first,
 * then the lines are imported into it through the same auto-match path
 * {@link useImportPurchaseListIntoOrder} uses. Status is left at DRAFT — the caller marks it
 * ordered once it has actually been sent.
 */
export function useCreateOrderFromPurchaseList() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      supplierName,
      reference,
      lines,
    }: CreateOrderFromListVars): Promise<CreateOrderFromListResult> => {
      const po = await getPurchaseOrderRepository().create({
        supplier: { supplierName },
        ...(reference ? { reference } : {}),
      });
      const summary = await importLinesInto(po.id, lines);
      return { ...summary, poId: po.id };
    },
    onSettled: (result) => invalidateOrders(client, result?.poId),
  });
}

/**
 * Import parsed lines into the wishlist. Each line becomes one entry via the same
 * `WishlistRepository.create` path the manual dialog uses, so the same name/link/price
 * validation applies.
 *
 * An entry the repository rejects (an unusable link or price on one row of an otherwise-good
 * file) is **skipped rather than aborting the import** — a bulk paste is far more useful when a
 * single bad cell costs one row instead of all of them — and counted in
 * {@link PurchaseListImportSummary.skipped} so the user is told it happened.
 */
export function useImportPurchaseListIntoWishlist() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (lines: readonly ParsedPurchaseListLine[]): Promise<PurchaseListImportSummary> => {
      const wishlist = getWishlistRepository();
      let added = 0;
      let skipped = 0;
      for (const line of lines) {
        try {
          await wishlist.create(toWishlistDraft(line));
          added += 1;
        } catch {
          skipped += 1;
        }
      }
      return { added, matched: 0, skipped };
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}
