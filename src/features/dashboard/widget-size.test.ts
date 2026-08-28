import { describe, expect, it } from 'vitest';
import { EXTRA_LIST_ROWS_PER_CELL, listColumns, listRowCount } from './widget-size';

/**
 * The row budget behind resizable dashboard cards (issue #441). The board's coordinate maths
 * lives in `dashboard-layout.ts`; this is the other half — what a card should *draw* once it
 * has been given more room.
 */
describe('listColumns', () => {
  it('keeps a single column until the card is widened', () => {
    expect(listColumns({ w: 1, h: 1 })).toBe(1);
    expect(listColumns({ w: 1, h: 2 })).toBe(1);
  });

  it('splits a widened card into two columns of rows', () => {
    expect(listColumns({ w: 2, h: 1 })).toBe(2);
    expect(listColumns({ w: 2, h: 2 })).toBe(2);
  });
});

describe('listRowCount', () => {
  it('leaves a default-sized card showing exactly the rows it always showed', () => {
    expect(listRowCount({ w: 1, h: 1 }, 3)).toBe(3);
    expect(listRowCount({ w: 1, h: 1 }, 4)).toBe(4);
  });

  it('buys more rows per column with height', () => {
    expect(listRowCount({ w: 1, h: 2 }, 3)).toBe(3 + EXTRA_LIST_ROWS_PER_CELL);
  });

  it('buys a second column of the same rows with width', () => {
    expect(listRowCount({ w: 2, h: 1 }, 3)).toBe(6);
  });

  it('compounds the two, so the largest card holds the most', () => {
    expect(listRowCount({ w: 2, h: 2 }, 3)).toBe((3 + EXTRA_LIST_ROWS_PER_CELL) * 2);
  });

  it('never shows fewer rows for a bigger card', () => {
    const sizes = [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 1, h: 2 },
      { w: 2, h: 2 },
    ];
    const counts = sizes.map((s) => listRowCount(s, 3));
    expect(Math.min(...counts)).toBe(counts[0]);
    expect(Math.max(...counts)).toBe(counts[3]);
  });
});
