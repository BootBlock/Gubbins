/**
 * Test / calibration / service record row + DTO (feature-gap G7).
 *
 * An append-only point recording a structured QA outcome against one **serialised** unit — a
 * `kind` (test / calibration / service), a `name`, a closed-vocabulary `result` (pass / fail /
 * …), an optional numeric `reading` + `unit`, an optional `note` and the effective `performed_at`
 * date. A real synced LWW row (carries `updated_at`), insert-only in practice, sitting beside its
 * owning item (`item_id` → items, ON DELETE CASCADE). All vocabulary/validation lives in the pure
 * `@/features/inventory/test-records` seam; `kind`/`result` are free TEXT (no DB CHECK) so a value
 * minted by a newer peer round-trips intact.
 */
import type { TestRecordKind, TestResult } from '@/features/inventory/test-records';

export interface TestRecordRow {
  readonly id: string;
  readonly item_id: string;
  readonly kind: string;
  readonly name: string;
  readonly result: string;
  readonly reading: number | null;
  readonly unit: string | null;
  readonly note: string | null;
  /** Effective date of the record (UNIX-ms). */
  readonly performed_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface TestRecord {
  readonly id: string;
  readonly itemId: string;
  readonly kind: TestRecordKind;
  readonly name: string;
  readonly result: TestResult;
  /** Optional measured numeric value (may be negative); null when the record logs no reading. */
  readonly reading: number | null;
  /** Optional unit for the reading (e.g. "MΩ"); null when there is no reading. */
  readonly unit: string | null;
  readonly note: string | null;
  /** Effective date of the record (UNIX-ms). */
  readonly performedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Parameters for recording a test / calibration / service result (feature-gap G7). */
export interface RecordTestResultInput {
  /** One of the {@link TestRecordKind} values; normalised by `planTestRecord`. Defaults to `TEST`. */
  readonly kind?: string | null;
  /** The check / test name (required, non-blank). */
  readonly name: string;
  /** One of the {@link TestResult} values; normalised by `planTestRecord`. Defaults to `PASS`. */
  readonly result?: string | null;
  /** Optional measured numeric value (may be negative); must be finite when supplied. */
  readonly reading?: number | null;
  /** Optional unit for the reading (dropped when no reading is given). */
  readonly unit?: string | null;
  /** Optional free-text note. */
  readonly note?: string | null;
  /** Effective date (UNIX-ms); defaults to "now" when omitted. */
  readonly performedAt?: number;
}
