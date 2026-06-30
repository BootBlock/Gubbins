/**
 * Asset-booking row/DTO types (spec §4 "Borrowing & Checking Out" extended; Phase 78).
 *
 * A booking is a **calendar reservation of one identifiable asset** for a whole-day date
 * range — distinct from the §4 project *quantity* reservation (`project_bom_lines`), which
 * is a stock annotation. Start/end are day-start UNIX-ms, inclusive of both days. The
 * lifecycle (upcoming / active / overdue / converted / cancelled) is **derived** from the
 * dates plus the two nullable columns below — see `@/features/bookings/booking-status`.
 */

export interface AssetBookingRow {
  readonly id: string;
  readonly item_id: string;
  readonly contact_id: string | null;
  readonly start_date: number;
  readonly end_date: number;
  readonly note: string | null;
  readonly cancelled_at: number | null;
  readonly converted_checkout_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AssetBooking {
  readonly id: string;
  readonly itemId: string;
  /** Optional contact the asset is reserved for (low-friction auto-created by name). */
  readonly contactId: string | null;
  /** Day-start UNIX-ms of the first booked day (inclusive). */
  readonly startDate: number;
  /** Day-start UNIX-ms of the last booked day (inclusive). */
  readonly endDate: number;
  readonly note: string | null;
  /** NULL until cancelled; set ⇒ derived status 'cancelled'. */
  readonly cancelledAt: number | null;
  /** NULL until converted to a loan; set ⇒ derived status 'converted'. Soft pointer, not a FK. */
  readonly convertedCheckoutId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A booking joined with its asset + contact display names, for list/screen rows. */
export interface AssetBookingWithNames extends AssetBooking {
  readonly itemName: string;
  /** NULL when the booking carries no contact. */
  readonly contactName: string | null;
}

export interface CreateBookingInput {
  readonly itemId: string;
  /** Existing contact id, OR a raw name to low-friction auto-create (§4 Ergonomics). */
  readonly contactId?: string | null;
  readonly contactName?: string | null;
  /** Any instant within the desired first day; snapped to the local day start. */
  readonly startDate: number;
  /** Any instant within the desired last day; snapped to the local day start. */
  readonly endDate: number;
  readonly note?: string | null;
}

/** A minimal pick-list entry for the booking form's asset picker. */
export interface BookableAsset {
  readonly id: string;
  readonly name: string;
  readonly trackingMode: string;
}

export interface ConvertBookingInput {
  /** Loan due date (UNIX-ms). Defaults to the booking's end day. */
  readonly dueDate?: number | null;
  /** Optionally supply/override the contact if the booking carries none. */
  readonly contactId?: string | null;
  readonly contactName?: string | null;
  readonly note?: string | null;
}
