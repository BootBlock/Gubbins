/**
 * Contact + checkout row/DTO types (spec §4 Borrowing & Checking Out, Phase 6).
 */
import type { CheckoutStatus } from '../constants';

export interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A contact plus its denormalised count of still-out (open) checkouts. */
export interface ContactWithCount extends Contact {
  readonly openCount: number;
}

export interface CreateContactInput {
  readonly name: string;
  readonly note?: string | null;
}

export interface UpdateContactInput {
  readonly name?: string;
  readonly note?: string | null;
}

export interface CheckoutRow {
  readonly id: string;
  readonly item_id: string;
  readonly contact_id: string;
  readonly quantity: number;
  readonly due_date: number | null;
  readonly checked_out_at: number;
  readonly returned_at: number | null;
  readonly note: string | null;
  readonly source_location_id: string | null;
  readonly source_batch_key: string | null;
  readonly updated_at: number;
}

export interface Checkout {
  readonly id: string;
  readonly itemId: string;
  readonly contactId: string;
  /** Units lent out on this checkout (DISCRETE on-hand is decremented while open). */
  readonly quantity: number;
  /** Optional due date (UNIX-ms) for overdue tracking (§4 Due Dates). */
  readonly dueDate: number | null;
  readonly checkedOutAt: number;
  /** NULL while the item is still out; set when returned (drives OPEN/RETURNED). */
  readonly returnedAt: number | null;
  readonly note: string | null;
  /**
   * The location the units were lent *from* (Phase 26, §4 per-location ledger). The
   * return restores stock here. NULL = no specific source (the item's primary location).
   */
  readonly sourceLocationId: string | null;
  /**
   * The canonical batch key of the specific lot the units were lent *from* (Phase 29,
   * §4 perishables). The return restores stock to *that lot* (its identity round-trips
   * from the key via `batchIdentityFromKey`). NULL = no specific lot (returned to the
   * source placement's untracked default batch — the Phase-28 behaviour).
   */
  readonly sourceBatchKey: string | null;
  readonly updatedAt: number;
}

/** A checkout joined with its item + contact display names, for list/dashboard rows. */
export interface CheckoutWithNames extends Checkout {
  readonly itemName: string;
  readonly contactName: string;
  readonly status: CheckoutStatus;
  /** True when the checkout is open and its due date is in the past. */
  readonly isOverdue: boolean;
}

export interface CheckoutItemInput {
  readonly itemId: string;
  /** Existing contact id, OR a raw name to low-friction auto-create (§4 Ergonomics). */
  readonly contactId?: string;
  readonly contactName?: string;
  readonly quantity?: number;
  readonly dueDate?: number | null;
  readonly note?: string | null;
  /**
   * The placement to lend from (Phase 26, §4 per-location ledger). When set on a DISCRETE
   * item, that location's stock is decremented (validated against *its* on-hand) and the
   * return restores there. Omitted/ignored for SERIALISED items and defaults to the item's
   * primary location.
   */
  readonly fromLocationId?: string;
  /**
   * The specific lot to lend (Phase 29, §4 perishables). When set on a DISCRETE item, *that
   * batch* at `fromLocationId` is drawn down (validated against the lot's own quantity) rather
   * than the placement's FEFO order, and the return restores to that exact lot. The empty
   * string targets the untracked default batch. Omitted = the Phase-28 FEFO behaviour.
   */
  readonly fromBatchKey?: string;
}
