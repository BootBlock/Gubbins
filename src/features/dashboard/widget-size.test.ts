import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '@/test/repo-path';
import { BOARD_SINGLE_COLUMN_QUERY, listColumns, listRowCount } from './widget-size';

/**
 * The row budget behind resizable dashboard cards (issue #441). The board's coordinate maths
 * lives in `dashboard-layout.ts`; this is the other half — what a card should *draw* once it
 * has been given more room.
 *
 * The counts below are written as literals on purpose. Restating the implementation's own
 * formula (`baseRows + (h - 1) * EXTRA_LIST_ROWS_PER_CELL`) would pass for any value of that
 * constant, and the constant is exactly what the wiki commits to in prose ("a 1×2 Recent
 * activity shows around a dozen entries instead of four"). Change it and these fail.
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

  it('buys eight more rows per column with height', () => {
    expect(listRowCount({ w: 1, h: 2 }, 3)).toBe(11);
    // The figure the wiki quotes for a tall Recent activity card.
    expect(listRowCount({ w: 1, h: 2 }, 4)).toBe(12);
  });

  it('buys a second column of the same rows with width', () => {
    expect(listRowCount({ w: 2, h: 1 }, 3)).toBe(6);
    expect(listRowCount({ w: 2, h: 1 }, 4)).toBe(8);
  });

  it('compounds the two, so the largest card holds the most', () => {
    expect(listRowCount({ w: 2, h: 2 }, 3)).toBe(22);
    expect(listRowCount({ w: 2, h: 2 }, 4)).toBe(24);
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

/**
 * The board applies its grid placement and cell spans only from Tailwind's `sm:` up, and the
 * widget bodies scale their content on the complement of that same width. The two are the same
 * decision written in two languages, so read the stylesheet rather than trusting the comments:
 * drift here draws a phone-width card as though it were a large one.
 */
describe('BOARD_SINGLE_COLUMN_QUERY ↔ the sm breakpoint', () => {
  it('matches the --breakpoint-sm declared in the stylesheet', () => {
    const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
    const declared = /--breakpoint-sm:\s*([^;]+);/.exec(css)?.[1]?.trim();
    expect(declared).toBeTruthy();
    expect(BOARD_SINGLE_COLUMN_QUERY).toBe(`(width < ${declared})`);
  });
});
