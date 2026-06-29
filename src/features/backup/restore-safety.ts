/**
 * Pure restore-safety assessments (the guards shown before a destructive **Replace**).
 *
 * Kept free of the DOM/DB so the decision logic — "is this restore destructive enough to
 * warn about?" — is unit-tested directly. The dialog gathers the live numbers (current item
 * count, storage estimate, the typed confirmation) and feeds them here.
 */
import type { ParsedBackup } from './backup-format';

/** The word the user must type to arm an erase-and-restore. */
export const REPLACE_CONFIRM_WORD = 'REPLACE';

/** Whether the typed text matches {@link REPLACE_CONFIRM_WORD} (case/space-insensitive). */
export function isReplaceConfirmed(typed: string): boolean {
  return typed.trim().toUpperCase() === REPLACE_CONFIRM_WORD;
}

/** How a Replace will change the dataset — drives the impact line and shrink/empty warnings. */
export interface RestoreImpact {
  readonly currentItems: number;
  readonly backupItems: number;
  /** The backup has no items at all — replacing would erase the inventory. */
  readonly empty: boolean;
  /** The backup has fewer items than there are now — a Replace would lose the difference. */
  readonly shrinking: boolean;
}

/** Assess how a Replace changes the item set. Pure. */
export function assessRestoreImpact(currentItems: number, backupItems: number): RestoreImpact {
  return {
    currentItems,
    backupItems,
    empty: backupItems === 0,
    shrinking: backupItems < currentItems,
  };
}

/** The heavy bytes a restore writes to storage (the exact DB copy + full-resolution images). */
export function estimateBackupBytes(parsed: Pick<ParsedBackup, 'sqlite' | 'images'>): number {
  let total = parsed.sqlite?.byteLength ?? 0;
  for (const image of parsed.images) total += image.bytes.byteLength;
  return total;
}

/** A storage head-room assessment for the incoming backup. */
export interface QuotaAssessment {
  /** Whether the estimate could be evaluated at all (false when the API is unavailable). */
  readonly known: boolean;
  /** Whether the incoming bytes fit in the available head-room (true when unknown — never block). */
  readonly willFit: boolean;
  readonly incomingBytes: number;
  readonly availableBytes: number;
}

/**
 * Whether the incoming backup is likely to fit. Conservative: a Replace overwrites the DB
 * rather than adding to it, so comparing the whole incoming payload against free head-room
 * over-estimates need — fine for a non-blocking warning. Unknown estimates never warn.
 */
export function assessQuota(
  incomingBytes: number,
  usage: number,
  quota: number,
  supported: boolean,
): QuotaAssessment {
  if (!supported || quota <= 0) {
    return { known: false, willFit: true, incomingBytes, availableBytes: 0 };
  }
  const availableBytes = Math.max(0, quota - usage);
  return { known: true, willFit: incomingBytes <= availableBytes, incomingBytes, availableBytes };
}
