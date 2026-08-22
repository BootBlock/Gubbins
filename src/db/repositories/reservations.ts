/**
 * Reading project reservations back as a stock figure (issue #653).
 *
 * `items.quantity` says how many units exist; it does not say how many are *free*. A project
 * reservation claims units that are already on the shelf, so an item can be fully stocked and
 * still have nothing spare. This is the read half that was missing: a reservation used to be
 * written and never consulted again, which let two projects each "actually reserve" the same
 * units with neither one's shopping list noticing.
 *
 * What counts as a live claim: a BOM line with a `TENTATIVE`/`ACTUAL` reservation of at least
 * one unit, on a project that is still `PLANNING` or `ACTIVE`. A `COMPLETED` or `ARCHIVED`
 * project has either drawn its parts or been put aside, so its lines hold nothing.
 *
 * Loans need no subtraction here: checking an item out already decrements `items.quantity`
 * (the units have physically left the building), so on-hand is a post-loan figure by
 * construction — unlike a reservation, which is only a ledger annotation.
 *
 * Shared by the item concern (what is reserved of *this* item) and the project costing concern
 * (is *this* line's reservation real?), so both can never disagree about what a claim is. The
 * arithmetic itself — who is backed by stock and who is over-committed — is the pure
 * `features/projects/reservations.ts` seam; this module only fetches its inputs.
 */
import {
  computeAvailabilityByItem,
  type ItemAvailability,
  type ReservationClaim,
} from '@/features/projects/reservations';
import type { IDatabaseDriver, SqlValue } from '../rpc/driver';

/** The `projects.status` values whose BOM lines still hold stock. */
export const OPEN_PROJECT_STATUSES = ['PLANNING', 'ACTIVE'] as const;

interface ClaimRow {
  readonly line_id: string;
  readonly item_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly reservation_status: string;
  readonly reserved_qty: number;
  readonly created_at: number;
}

interface StockRow {
  readonly id: string;
  readonly quantity: number;
  readonly is_unlimited: number;
}

/**
 * How much of each item is spoken for, and by which projects, in one round-trip.
 *
 * Every requested id that names a real item gets an entry, claimed or not — a caller asking
 * "is this reserved?" gets an answer rather than a missing key it has to read as "no". An id
 * matching no item is simply absent, so a caller never draws "0 available" for an item that
 * isn't there.
 *
 * Two queries rather than one join: the claims are a small set of unbounded size per item
 * while the stock figures are exactly one row per item, and joining them would repeat each
 * item's quantity once per claim for the caller to de-duplicate.
 */
export async function readAvailability(
  driver: IDatabaseDriver,
  itemIds: readonly string[],
): Promise<Map<string, ItemAvailability>> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return new Map();

  const placeholders = unique.map(() => '?').join(', ');
  const stockRows = await driver.query<StockRow>(
    `SELECT id, quantity, is_unlimited FROM items WHERE id IN (${placeholders});`,
    unique as SqlValue[],
  );
  if (stockRows.length === 0) return new Map();

  const statusPlaceholders = OPEN_PROJECT_STATUSES.map(() => '?').join(', ');
  const claimRows = await driver.query<ClaimRow>(
    `SELECT l.id                 AS line_id,
            l.item_id            AS item_id,
            l.project_id         AS project_id,
            p.name               AS project_name,
            l.reservation_status AS reservation_status,
            l.reserved_qty       AS reserved_qty,
            l.created_at         AS created_at
     FROM project_bom_lines l
     JOIN projects p ON p.id = l.project_id
     WHERE l.item_id IN (${placeholders})
       AND l.reservation_status <> 'NONE'
       AND l.reserved_qty > 0
       AND p.status IN (${statusPlaceholders});`,
    [...unique, ...OPEN_PROJECT_STATUSES] as SqlValue[],
  );

  return computeAvailabilityByItem(
    stockRows.map((row) => ({
      itemId: row.id,
      onHandQty: Number(row.quantity),
      isUnlimited: Number(row.is_unlimited) === 1,
    })),
    claimRows.map(rowToClaim),
  );
}

/**
 * A claim row as the pure seam wants it. The `reservation_status` CHECK constraint admits only
 * `NONE`/`TENTATIVE`/`ACTUAL` and the query excludes `NONE`, so anything left is `ACTUAL` when
 * it says so and `TENTATIVE` otherwise.
 */
function rowToClaim(row: ClaimRow): ReservationClaim {
  return {
    lineId: row.line_id,
    itemId: row.item_id,
    projectId: row.project_id,
    projectName: row.project_name,
    status: row.reservation_status === 'ACTUAL' ? 'ACTUAL' : 'TENTATIVE',
    reservedQty: Number(row.reserved_qty),
    createdAt: Number(row.created_at),
  };
}
