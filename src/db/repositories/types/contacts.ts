/**
 * Contact + checkout row/DTO types (spec §4 Borrowing & Checking Out, Phase 6).
 */
import type { BorrowerType, CheckoutStatus } from '../constants';

export interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly phone_mobile: string | null;
  readonly phone_home: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly phoneMobile: string | null;
  readonly phoneHome: string | null;
  readonly email: string | null;
  readonly address: string | null;
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
  readonly phoneMobile?: string | null;
  readonly phoneHome?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
}

export interface UpdateContactInput {
  readonly name?: string;
  readonly note?: string | null;
  readonly phoneMobile?: string | null;
  readonly phoneHome?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
}

export interface CheckoutRow {
  readonly id: string;
  readonly item_id: string;
  /** Borrower tagged union (B4): exactly one of contact/project/location is non-null. */
  readonly contact_id: string | null;
  readonly project_id: string | null;
  readonly location_id: string | null;
  readonly quantity: number;
  readonly due_date: number | null;
  readonly checked_out_at: number;
  readonly returned_at: number | null;
  readonly note: string | null;
  readonly return_note: string | null;
  readonly source_location_id: string | null;
  readonly source_batch_key: string | null;
  /**
   * The operation key the loan's stock draw was captured under (issue #711) — set only for a loan
   * whose ids are derived from a one-shot operation, NULL for an ordinary loan. The merge reads it
   * to find the draw's `stock_deltas` rows; see the column's note in the baseline.
   */
  readonly stock_operation_key: string | null;
  readonly updated_at: number;
}

export interface Checkout {
  readonly id: string;
  readonly itemId: string;
  /**
   * The borrower tagged union (B4). Exactly one of {@link contactId} / {@link projectId} /
   * {@link locationId} is non-null (the DB enforces this via the `checkouts` XOR CHECK);
   * {@link borrowerType} names which one, so consumers can switch without re-deriving it.
   */
  readonly borrowerType: BorrowerType;
  /** Non-null when this loan is to a contact (a person). */
  readonly contactId: string | null;
  /** Non-null when this loan is to a project ("out on the Henderson job"). */
  readonly projectId: string | null;
  /** Non-null when this loan is to a location ("in the van"). */
  readonly locationId: string | null;
  /** Units lent out on this checkout (DISCRETE on-hand is decremented while open). */
  readonly quantity: number;
  /** Optional due date (UNIX-ms) for overdue tracking (§4 Due Dates). */
  readonly dueDate: number | null;
  readonly checkedOutAt: number;
  /** NULL while the item is still out; set when returned (drives OPEN/RETURNED). */
  readonly returnedAt: number | null;
  /** The note captured when the units were lent *out* (the reason for the loan). */
  readonly note: string | null;
  /**
   * The note captured when the units were checked back *in* (e.g. "returned with a chipped
   * blade"). Kept separate from {@link note} so a return remark never overwrites the loan's
   * own note — both ends of the loan retain their own text. NULL while the loan is still open.
   */
  readonly returnNote: string | null;
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

/** A checkout joined with its item + borrower display names, for list/dashboard rows. */
export interface CheckoutWithNames extends Checkout {
  readonly itemName: string;
  /**
   * The borrower's display name, resolved per {@link Checkout.borrowerType} (the contact's,
   * project's or location's name). Pair with `borrowerType` when a label needs to distinguish
   * the kind of target; on its own it is the "on loan to …" name for any target.
   */
  readonly borrowerName: string;
  readonly status: CheckoutStatus;
  /** True when the checkout is open and its due date is in the past. */
  readonly isOverdue: boolean;
}

/**
 * A resolved borrower (B4) — the single target a loan is checked out to, after the
 * {@link CheckoutItemInput} discriminator has been resolved to an existing row. `contact`
 * targets may be auto-created by name; `project` / `location` are always existing rows.
 */
export interface CheckoutBorrower {
  readonly type: BorrowerType;
  readonly id: string;
  readonly name: string;
}

export interface CheckoutItemInput {
  readonly itemId: string;
  /** Existing contact id, OR a raw name to low-friction auto-create (§4 Ergonomics). */
  readonly contactId?: string;
  readonly contactName?: string;
  /**
   * Loan to a project instead of a contact (B4) — an existing project id (never created by
   * name). Mutually exclusive with the contact and location targets: supply exactly one.
   */
  readonly projectId?: string;
  /**
   * Loan to a location instead of a contact (B4) — an existing location id (never created by
   * name). This is the loan *target* ("in the van"), distinct from {@link fromLocationId}
   * (the provenance — where the units are drawn from). Supply exactly one borrower target.
   */
  readonly locationId?: string;
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
  /**
   * Deterministic ids for a loan that is the artefact of a **one-shot operation** two devices
   * can each run offline before they sync — converting one booking (issue #542).
   *
   * Omitted for an ordinary loan, which is genuinely new on the device that records it and so
   * takes a fresh `crypto.randomUUID()` and a random stock-delta id. Supplied, every id the
   * checkout writes is derived from the operation's own stable identity, so both devices compute
   * the *same* ids and the merge collapses their two runs to one loan, one ledger entry and one
   * stock movement instead of keeping both. See {@link CheckoutDerivedIds}.
   */
  readonly derivedIds?: CheckoutDerivedIds;
}

/**
 * The deterministic ids a one-shot loan derives from its operation's identity, rather than
 * minting at random (issues #195, #696, #542).
 *
 * Each covers a different convergence seam, and all three are needed for the two runs to merge
 * cleanly: `checkoutId` is the `checkouts` row's own primary key, which the id-keyed
 * last-write-wins union collapses; `historyId` is the `CHECKED_OUT` ledger entry's, which the
 * append-only union-by-id collapses; and `operationKey` is the key the `stock_batches` capture
 * triggers derive their `stock_deltas` ids from while the draw runs, so the Delta-CRDT replay
 * counts one movement rather than two.
 *
 * Every value must be a canonical lower-case UUID derived from stable inputs — see `uuidv5` in
 * `src/lib/derived-uuid.ts`. `operationKey` in particular is validated by `withOperationKey`
 * and by a column CHECK, because a key carrying the derivation's own separator or wildcards
 * would mint colliding ids instead of failing loudly.
 */
export interface CheckoutDerivedIds {
  /** The `checkouts` row id. */
  readonly checkoutId: string;
  /** The `CHECKED_OUT` Activity Log entry's id. */
  readonly historyId: string;
  /** The `stock_delta_capture.operation_key` the draw's delta ids are derived from. */
  readonly operationKey: string;
}
