import { describe, it, expect } from 'vitest';
import {
  AVG_ROW_BYTES,
  estimateTableBytes,
  pruneCutoff,
  monthsLabel,
  buildHistoryArchive,
  HISTORY_ARCHIVE_FORMAT_VERSION,
  type TableRowCounts,
} from './triage';

const ZERO: TableRowCounts = { items: 0, itemHistory: 0, itemImages: 0 };

describe('OPFS table byte estimation (spec §7.6.2)', () => {
  it('multiplies each row count by its average byte-size', () => {
    const counts: TableRowCounts = { items: 10, itemHistory: 100, itemImages: 5 };
    const estimate = estimateTableBytes(counts);
    expect(estimate.items).toBe(10 * AVG_ROW_BYTES.items);
    expect(estimate.itemHistory).toBe(100 * AVG_ROW_BYTES.itemHistory);
    expect(estimate.itemImages).toBe(5 * AVG_ROW_BYTES.itemImages);
  });

  it('sums the three tables into the total', () => {
    const counts: TableRowCounts = { items: 3, itemHistory: 7, itemImages: 2 };
    const estimate = estimateTableBytes(counts);
    expect(estimate.total).toBe(estimate.items + estimate.itemHistory + estimate.itemImages);
  });

  it('returns all zeroes for an empty database', () => {
    const estimate = estimateTableBytes(ZERO);
    expect(estimate).toEqual({ items: 0, itemHistory: 0, itemImages: 0, total: 0 });
  });

  it('weights images far heavier than history or item rows (full-res dominates OPFS)', () => {
    expect(AVG_ROW_BYTES.itemImages).toBeGreaterThan(AVG_ROW_BYTES.items);
    expect(AVG_ROW_BYTES.itemImages).toBeGreaterThan(AVG_ROW_BYTES.itemHistory);
  });

  it('treats a negative or non-finite count as zero rather than a negative estimate', () => {
    const estimate = estimateTableBytes({
      items: -5,
      itemHistory: Number.NaN,
      itemImages: 4,
    });
    expect(estimate.items).toBe(0);
    expect(estimate.itemHistory).toBe(0);
    expect(estimate.itemImages).toBe(4 * AVG_ROW_BYTES.itemImages);
  });

  it('prefers measured OPFS image bytes over the per-row heuristic when supplied', () => {
    const counts: TableRowCounts = { items: 2, itemHistory: 5, itemImages: 3 };
    // 3 full-res files measured at 250 KB total; the image figure is that true size
    // plus a small thumbnail estimate per row — not 3 × the rough 110 KB heuristic.
    const estimate = estimateTableBytes(counts, { itemImagesBytes: 250_000 });
    expect(estimate.itemImages).toBe(250_000 + 3 * AVG_ROW_BYTES.itemImageThumbnail);
    expect(estimate.itemImages).not.toBe(3 * AVG_ROW_BYTES.itemImages);
    expect(estimate.total).toBe(estimate.items + estimate.itemHistory + estimate.itemImages);
  });

  it('falls back to the heuristic for null/invalid measured bytes', () => {
    const counts: TableRowCounts = { items: 1, itemHistory: 1, itemImages: 4 };
    expect(estimateTableBytes(counts, { itemImagesBytes: null }).itemImages).toBe(
      4 * AVG_ROW_BYTES.itemImages,
    );
    expect(estimateTableBytes(counts, { itemImagesBytes: Number.NaN }).itemImages).toBe(
      4 * AVG_ROW_BYTES.itemImages,
    );
    expect(estimateTableBytes(counts, { itemImagesBytes: -10 }).itemImages).toBe(
      4 * AVG_ROW_BYTES.itemImages,
    );
  });

  it('uses measured bytes even with zero image rows (counts the files on disk)', () => {
    const estimate = estimateTableBytes(
      { items: 0, itemHistory: 0, itemImages: 0 },
      { itemImagesBytes: 4_096 },
    );
    expect(estimate.itemImages).toBe(4_096);
  });
});

describe('pruning cutoff (spec §7.6.3 Workflow A)', () => {
  // A fixed reference instant: 2026-06-27T12:00:00.000Z.
  const NOW = Date.UTC(2026, 5, 27, 12, 0, 0);

  it('returns the instant exactly N calendar months before now', () => {
    const cutoff = pruneCutoff(NOW, 6);
    expect(cutoff).toBe(Date.UTC(2025, 11, 27, 12, 0, 0));
  });

  it('handles a 12-month (one year) window', () => {
    const cutoff = pruneCutoff(NOW, 12);
    expect(cutoff).toBe(Date.UTC(2025, 5, 27, 12, 0, 0));
  });

  it('clamps to a day that does not exist in the target month', () => {
    // 31 May minus 3 months would be 28 Feb (no 31st in Feb) — must not roll into March.
    const may31 = Date.UTC(2026, 4, 31, 9, 0, 0);
    const cutoff = pruneCutoff(may31, 3);
    expect(new Date(cutoff).getUTCMonth()).toBe(1); // February, not March
  });

  it('rejects a non-positive month window (nothing should be pruned)', () => {
    expect(() => pruneCutoff(NOW, 0)).toThrow();
    expect(() => pruneCutoff(NOW, -1)).toThrow();
  });
});

describe('month-window labels', () => {
  it('renders a friendly British-English label', () => {
    expect(monthsLabel(1)).toBe('1 month');
    expect(monthsLabel(6)).toBe('6 months');
    expect(monthsLabel(12)).toBe('12 months');
  });
});

describe('cold-storage history archive (spec §7.6.3 Workflow A)', () => {
  it('wraps the targeted rows in a versioned, round-trippable payload', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const json = buildHistoryArchive(rows, 5_000, 9_999);
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(HISTORY_ARCHIVE_FORMAT_VERSION);
    expect(parsed.archivedAt).toBe(9_999);
    expect(parsed.cutoff).toBe(5_000);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.rows).toEqual(rows);
  });

  it('handles an empty archive', () => {
    const parsed = JSON.parse(buildHistoryArchive([], 1, 2));
    expect(parsed.rowCount).toBe(0);
    expect(parsed.rows).toEqual([]);
  });
});
