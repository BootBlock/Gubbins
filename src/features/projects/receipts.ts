/**
 * Pure procurement-receipt maths (spec §4 "The Liminal Space of Procurement").
 *
 * A BOM line is received into stock in one or more instalments (a partial / split
 * receipt). The cumulative `received_qty` is the line's *primary* record of how much
 * has physically arrived — not a derived projection, but the source of truth for the
 * instalment progress — while the *outstanding* (still-incoming) quantity is derived
 * from it (`required − received`). Keeping this arithmetic pure and isolated mirrors
 * the `cycle-count.ts` reconciliation seam: the repository trusts this plan and only
 * persists the result.
 *
 * It also owns the *other* half of a receipt the repository must not decide twice: whether the
 * arriving units can land in stock at all, which depends on the matched item's tracking mode
 * (issue #608). Both receive paths and both receive dialogs read it from here.
 */
import { assertExhaustive } from '@/lib/exhaustive';
import type { TrackingMode } from '@/db/repositories/constants';

export interface ReceiptPlan {
  /** Units accepted by this instalment — clamped to the outstanding remainder. */
  readonly receivedDelta: number;
  /** Cumulative received quantity after this instalment. */
  readonly nextReceivedQty: number;
  /** Quantity still to arrive after this instalment (never negative). */
  readonly outstandingQty: number;
  /** True once the cumulative received quantity meets the requirement. */
  readonly fullyReceived: boolean;
}

/**
 * Plan a single receipt instalment against a line's requirement and prior receipts.
 *
 * - `requestedQty` omitted → receive the whole outstanding remainder (the common
 *   "receive it all" action, and the pre-Phase-24 wholesale behaviour).
 * - A requested quantity is floored to a whole unit, never negative, and clamped to
 *   the outstanding remainder so a receipt can never overshoot the requirement.
 * - The line is `fullyReceived` only once cumulative receipts reach the requirement;
 *   until then it stays open for further instalments.
 */
export function planReceipt(requiredQty: number, receivedQty: number, requestedQty?: number): ReceiptPlan {
  const remaining = Math.max(0, requiredQty - receivedQty);
  const requested = requestedQty === undefined ? remaining : Math.max(0, Math.floor(requestedQty));
  const receivedDelta = Math.min(requested, remaining);
  const nextReceivedQty = receivedQty + receivedDelta;
  return {
    receivedDelta,
    nextReceivedQty,
    outstandingQty: Math.max(0, requiredQty - nextReceivedQty),
    fullyReceived: nextReceivedQty >= requiredQty,
  };
}

/** The still-incoming quantity of a line — its requirement less what has arrived. */
export function outstandingQty(line: { readonly requiredQty: number; readonly receivedQty: number }): number {
  return Math.max(0, line.requiredQty - line.receivedQty);
}

/**
 * Where a receipt for a matched item actually lands.
 *
 * - `COUNT` — the units enter the per-location / per-batch quantity ledger, the item's
 *   on-hand figure grows, and a destination location and batch identity are meaningful.
 * - `RECORD_ONLY` — the delivery is recorded against the line and in the item's Activity
 *   Log, but no stock moves, because the item has no counted quantity to move it into.
 */
export type ReceiptLanding = 'COUNT' | 'RECORD_ONLY';

/**
 * How a receipt against an item of this tracking mode lands (issue #608).
 *
 * Only a `DISCRETE` item holds a divisible, countable quantity, so it is the only mode a
 * receipt can add units to. The other three are record-only for reasons the rest of the app
 * already enforces, not for the receipt's own convenience: `items` carries
 * `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)`, so a serialised row cannot be
 * grown by count at all; a gauge holds a *measure* in one vessel rather than a count of
 * units; and `UNTRACKED` deliberately has no quantity — `adjustQuantity` and `transferStock`
 * both refuse all three for exactly the same reason.
 *
 * This is the seam both the write and the dialogs read, so the two cannot disagree: planning
 * a receipt one way while executing it the other is how a dialog comes to promise stock that
 * never arrives, which is the defect this exists to close.
 */
export function receiptLandingFor(trackingMode: TrackingMode): ReceiptLanding {
  return trackingMode === 'DISCRETE' ? 'COUNT' : 'RECORD_ONLY';
}

/**
 * The message key naming a record-only clause in the UI catalogs, so a translated sentence the
 * clause is spliced into does not end in English (issue #589). One key per arm of
 * {@link recordOnlyReason}'s switch; `src/features/projects/receipts.test.ts` drives both sides and
 * asserts the English catalog value equals `text`, so the two Englishes cannot drift apart.
 */
export type RecordOnlyReasonKey =
  | 'receipt.recordOnly.serialised'
  | 'receipt.recordOnly.gauge'
  | 'receipt.recordOnly.untracked'
  | 'receipt.recordOnly.unspecified';

/** A record-only clause in both the forms callers need: stored English, and a translatable key. */
export interface RecordOnlyReason {
  /**
   * The English clause, for text a *record* keeps rather than a screen renders — a ledger note is
   * stored once and read later on any device, so it cannot be resolved against a reader's language.
   */
  readonly text: string;
  /** The catalog key for the same clause, for a screen that renders it. */
  readonly messageKey: RecordOnlyReasonKey;
}

/**
 * Why a receipt against this item records the delivery without moving stock — a clause that
 * reads naturally after "No stock was added: " in a ledger note, and after "because " in the
 * dialogs. Movement-neutral wording, so the same clause serves a receipt and a
 * return-to-supplier.
 *
 * `DISCRETE` has no reason to give, because its receipts do move stock, so this returns null
 * rather than inventing one. That makes "there is a reason" and "the receipt is record-only"
 * the same statement — the two functions agree for every mode by construction, including an
 * out-of-band one, and a test pins that so a caller may read either as the other.
 *
 * The English clause and its catalog key come out of this one switch together, so a mode can
 * never gain one without the other.
 */
export function recordOnlyReason(trackingMode: TrackingMode): RecordOnlyReason | null {
  switch (trackingMode) {
    case 'SERIALISED':
      return {
        text: 'each unit of a serialised item is tracked as its own record, so it has no counted quantity',
        messageKey: 'receipt.recordOnly.serialised',
      };
    case 'CONSUMABLE_GAUGE':
      return {
        text: 'a consumable is measured by how full it is, not by a count of units',
        messageKey: 'receipt.recordOnly.gauge',
      };
    case 'UNTRACKED':
      return {
        text: 'an untracked item is listed but never counted',
        messageKey: 'receipt.recordOnly.untracked',
      };
    case 'DISCRETE':
      return null;
    default:
      assertExhaustive(trackingMode);
      // An out-of-band mode (a row written by a newer build) is not counted here either, so the
      // honest, non-specific clause is the right degradation rather than a crash.
      return { text: 'this item has no counted quantity', messageKey: 'receipt.recordOnly.unspecified' };
  }
}

/**
 * The English clause alone — {@link recordOnlyReason}'s `text`, for the ledger notes and the
 * English-only dialogs that read it. Derived, never a second switch.
 */
export function recordOnlyReceiptReason(trackingMode: TrackingMode): string | null {
  return recordOnlyReason(trackingMode)?.text ?? null;
}
