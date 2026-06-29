import { describe, expect, it } from 'vitest';
import { listRowCount, resolveListRow } from './list-window';

describe('listRowCount', () => {
  it('counts whole rows for an untrimmed window (firstItemIndex 0)', () => {
    expect(listRowCount(0, 0, 1)).toBe(0);
    expect(listRowCount(0, 50, 1)).toBe(50);
    expect(listRowCount(0, 50, 3)).toBe(17); // ceil(50/3)
    expect(listRowCount(0, 7, 3)).toBe(3); // partial last row rounds up
  });

  it('counts in absolute space once the front is trimmed', () => {
    // 6 pages of 50 resident, first page (0..49) trimmed → window [50, 350).
    expect(listRowCount(50, 300, 1)).toBe(350);
    expect(listRowCount(50, 300, 3)).toBe(Math.ceil(350 / 3));
  });

  it('guards a zero/negative column count', () => {
    expect(listRowCount(0, 50, 0)).toBe(0);
    expect(listRowCount(50, 300, -1)).toBe(0);
  });
});

describe('resolveListRow', () => {
  it('maps a fully-resident single-column row to one item', () => {
    const row = resolveListRow(10, 1, 0, 50);
    expect(row).toEqual({ start: 10, end: 11, resident: true, aboveWindow: false });
  });

  it('maps a fully-resident multi-column row to a column-wide slice', () => {
    const row = resolveListRow(2, 3, 0, 50);
    expect(row.start).toBe(6);
    expect(row.end).toBe(9);
    expect(row.resident).toBe(true);
    expect(row.aboveWindow).toBe(false);
  });

  it('clamps the final partial row to the resident length', () => {
    // 7 items, 3 columns → row 2 holds items 6 only.
    const row = resolveListRow(2, 3, 0, 7);
    expect(row.start).toBe(6);
    expect(row.end).toBe(7);
    expect(row.resident).toBe(true);
  });

  it('flags a row trimmed entirely off the front as above-window and non-resident', () => {
    // window [50, 350); row 5 covers absolute items 50? no — row 5 * 10 = 50.
    // Use columns 10: row 0 covers 0..9, fully above a window starting at 50.
    const row = resolveListRow(0, 10, 50, 300);
    expect(row.resident).toBe(false);
    expect(row.aboveWindow).toBe(true);
    expect(row.start).toBe(0);
    expect(row.end).toBe(0);
  });

  it('handles a row straddling the trim boundary (partly above, partly resident)', () => {
    // columns 3, window starts at 50: row 16 covers absolute items 48,49,50.
    // 48,49 are above the window; 50 is the first resident item.
    const row = resolveListRow(16, 3, 50, 300);
    expect(row.start).toBe(0); // clamp(48-50) → 0
    expect(row.end).toBe(1); // clamp(51-50) → 1 → item at resident index 0
    expect(row.resident).toBe(true);
    expect(row.aboveWindow).toBe(true); // absStart 48 < 50 → refill the prefix
  });

  it('maps a resident row inside a trimmed window to the right slice', () => {
    // window [50, 350); single column; absolute row 100 → resident index 50.
    const row = resolveListRow(100, 1, 50, 300);
    expect(row.start).toBe(50);
    expect(row.end).toBe(51);
    expect(row.resident).toBe(true);
    expect(row.aboveWindow).toBe(false);
  });
});
