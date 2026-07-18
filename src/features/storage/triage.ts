/**
 * Storage Triage maths (spec §7.6.2, §7.6.3).
 *
 * Pure, side-effect-free helpers so the OPFS byte-estimate heuristics and the
 * history-pruning cutoff are unit-tested in isolation and shared by the repository
 * read layer and the Triage Dashboard UI. SQLite WASM cannot cheaply query true
 * table byte-sizes (§7.6.2), so consumption is *estimated* as row count × an
 * average byte-size per table — deliberately rough, tunable constants.
 */

import { plural } from '@/lib/plural';

export interface TableRowCounts {
  readonly items: number;
  readonly itemHistory: number;
  /**
   * Photo rows across **every** table that anchors an OPFS image — item images and
   * location photos (issue #81). They share one flat `images/` directory and one row
   * shape (thumbnail blob + full-resolution path), so they estimate identically and are
   * counted together.
   */
  readonly photos: number;
}

export interface TableByteEstimate extends TableRowCounts {
  /** Sum of the three table estimates. */
  readonly total: number;
}

/**
 * Average bytes-per-row heuristics (§7.6.2). `photos` is weighted far heavier because
 * each photo row anchors a full-resolution WebP file in OPFS (~100 KB) plus its
 * thumbnail blob — the dominant OPFS consumer — whereas `items` and `item_history` are
 * lightweight scalar rows.
 *
 * `photoThumbnail` is the per-row estimate of the in-database thumbnail blob, used only
 * when the *real* full-resolution OPFS bytes are measured and supplied (see
 * {@link estimateTableBytes}); the full-res files then contribute their true size and
 * only the small thumbnail is approximated.
 */
export const AVG_ROW_BYTES = {
  items: 600,
  itemHistory: 200,
  photos: 110_000,
  photoThumbnail: 12_000,
} as const;

/** Coerce a row count to a safe non-negative integer (defensive against bad input). */
function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Coerce a measured byte figure to a safe non-negative integer, else null. */
function safeBytes(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export interface EstimateOptions {
  /**
   * The *measured* total size, in bytes, of the full-resolution image files actually
   * on disk in OPFS (summed via `imagesBytesOnDisk()`, which spans the whole shared
   * directory and so already covers both owning tables). When supplied, the photo figure
   * becomes this true size plus a small per-row thumbnail estimate, rather than the
   * deliberately-rough `AVG_ROW_BYTES.photos` heuristic (§7.6.2). Pass `null`/omit where
   * OPFS cannot be measured (e.g. the unit test environment).
   */
  readonly photoBytes?: number | null;
}

/**
 * Estimate per-table OPFS consumption (§7.6.2). The `items`/`item_history` figures
 * are always row-count × avg-byte heuristics; the photo figure prefers the
 * *measured* on-disk OPFS bytes when {@link EstimateOptions.photoBytes} is
 * supplied (the accurate path), falling back to the flat per-row heuristic otherwise.
 */
export function estimateTableBytes(counts: TableRowCounts, options: EstimateOptions = {}): TableByteEstimate {
  const items = safeCount(counts.items) * AVG_ROW_BYTES.items;
  const itemHistory = safeCount(counts.itemHistory) * AVG_ROW_BYTES.itemHistory;
  const measured = safeBytes(options.photoBytes);
  const photos =
    measured !== null
      ? measured + safeCount(counts.photos) * AVG_ROW_BYTES.photoThumbnail
      : safeCount(counts.photos) * AVG_ROW_BYTES.photos;
  return { items, itemHistory, photos, total: items + itemHistory + photos };
}

/** Days in a given UTC month (0-indexed), accounting for leap years. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The UNIX-ms instant exactly `months` calendar months before `now` (§7.6.3 A).
 * Rows in `item_history` created strictly before this are pruning candidates. The
 * day-of-month is clamped so e.g. 31 May − 3 months resolves to 28/29 Feb rather
 * than silently rolling into March.
 */
export function pruneCutoff(now: number, months: number): number {
  if (!Number.isFinite(months) || months <= 0) {
    throw new Error('Pruning window must be a positive number of months.');
  }
  const d = new Date(now);
  const targetMonthAbsolute = d.getUTCFullYear() * 12 + d.getUTCMonth() - Math.floor(months);
  const year = Math.floor(targetMonthAbsolute / 12);
  const monthIndex = ((targetMonthAbsolute % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInUtcMonth(year, monthIndex));
  return Date.UTC(
    year,
    monthIndex,
    day,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** Pluralised month-window label (en-GB) for the dashboard controls. */
export function monthsLabel(months: number): string {
  return `${months} ${plural(months, 'month')}`;
}

/**
 * Schema version of the cold-storage history archive payload (§7.6.3 A).
 *
 * @internal Exported for unit tests only.
 */
export const HISTORY_ARCHIVE_FORMAT_VERSION = 1;

export interface HistoryArchive<T> {
  readonly formatVersion: number;
  readonly archivedAt: number;
  /** The pruning cutoff — every row was created strictly before this. */
  readonly cutoff: number;
  readonly rowCount: number;
  readonly rows: readonly T[];
}

/**
 * Build the "cold storage" JSON archive of the history rows about to be pruned
 * (§7.6.3 Workflow A safeguard) — downloaded *before* the DELETE so the audit trail
 * is never lost. Generic over the row type so this pure module never imports the db
 * layer (no cycle). Pretty-printed for human/DB-Browser inspection.
 */
export function buildHistoryArchive<T>(
  rows: readonly T[],
  cutoff: number,
  archivedAt: number = Date.now(),
): string {
  const payload: HistoryArchive<T> = {
    formatVersion: HISTORY_ARCHIVE_FORMAT_VERSION,
    archivedAt,
    cutoff,
    rowCount: rows.length,
    rows,
  };
  return JSON.stringify(payload, null, 2);
}
