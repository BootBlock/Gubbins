/**
 * The count sheet's rendering at size (issue #561).
 *
 * A location's count is uncapped, so a bulk-storage shelf can put thousands of lines on this
 * sheet. An ordinary drawer must still render as it always did — every row in the DOM, growing
 * with the dialog — while a long one windows instead of putting an `<Input>` per line in front
 * of an auditor standing at the shelf.
 *
 * happy-dom lays nothing out, so the scroll container's height is stubbed below: without it
 * the virtualiser sees a zero-height viewport, renders no rows at all, and a test asserting
 * "fewer rows than lines" would pass while proving nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CycleCountLines } from './CycleCountLines';
import type { LocationCycleCount } from '../useLocationCycleCount';

const VIEWPORT_HEIGHT = 300;

/**
 * The virtualiser sizes its viewport from `offsetHeight`, which happy-dom always reports as 0.
 * Give the scroll container a height for the duration of this file so the window it computes
 * is a real one.
 */
const OFFSET_KEYS = ['offsetHeight', 'offsetWidth'] as const;
const originalOffsets = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const key of OFFSET_KEYS) {
    originalOffsets.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => (key === 'offsetHeight' ? VIEWPORT_HEIGHT : 600),
    });
  }
});

afterAll(() => {
  for (const key of OFFSET_KEYS) {
    const descriptor = originalOffsets.get(key);
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

afterEach(cleanup);

/** A sheet of `n` discrete count lines, each expecting 10. */
function sheet(n: number): LocationCycleCount {
  const lines = Array.from({ length: n }, (_, i) => ({
    key: `item-${i}|default`,
    itemId: `item-${i}`,
    name: `Part ${i}`,
    expected: 10,
    batch: { batchNumber: null, lotNumber: null, expiryDate: null },
  }));
  return {
    lines,
    counts: {},
    setCount: () => {},
    serialised: [],
    presence: {},
    setPresence: () => {},
  } as unknown as LocationCycleCount;
}

const countInputs = () => screen.getAllByLabelText(/^Counted quantity for /);

describe('CycleCountLines', () => {
  it('renders an ordinary drawer whole', () => {
    render(<CycleCountLines count={sheet(12)} />);
    expect(countInputs()).toHaveLength(12);
    // A short sheet keeps its old markup: the list itself, growing with the dialog. A windowed
    // sheet of twelve rows would also have all twelve in the DOM (they fit the stubbed
    // viewport), so the row count alone would not tell the two modes apart.
    expect(screen.getByTestId('cycle-count-lines').tagName).toBe('UL');
  });

  it('windows a bulk location to what fits on screen, not what is on the shelf', () => {
    render(<CycleCountLines count={sheet(400)} />);
    expect(screen.getByTestId('cycle-count-lines').tagName).toBe('DIV');
    const rendered = countInputs();
    // A window over a 300px viewport plus overscan — a small multiple of the rows that fit,
    // and nowhere near the 400 lines the sheet holds.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(40);
    // The rows that *are* rendered are the ones at the top of the sheet, in order.
    expect(rendered[0]).toHaveAttribute('aria-label', 'Counted quantity for Part 0');
    expect(rendered[1]).toHaveAttribute('aria-label', 'Counted quantity for Part 1');
  });

  it('keeps every line countable — the sheet scrolls, the count is not truncated', () => {
    const count = sheet(400);
    render(<CycleCountLines count={count} />);
    // The window is a rendering decision, never a count one: the sheet still holds all 400
    // lines, which is what the coverage and variance arithmetic reads.
    expect(count.lines).toHaveLength(400);
    // The scroll extent covers every line — at least one estimated row height each — so the
    // rows that are not mounted are reachable rather than absent.
    const extent = screen.getByTestId('cycle-count-lines').querySelector('ul')!;
    expect(Number.parseFloat((extent as HTMLElement).style.height)).toBeGreaterThanOrEqual(400 * 62);
  });

  it('tells assistive tech the whole sheet’s size, not the window’s', () => {
    render(<CycleCountLines count={sheet(400)} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeLessThan(400); // windowed, so the DOM count is not the answer
    for (const row of rows) expect(row).toHaveAttribute('aria-setsize', '400');
    expect(rows[0]).toHaveAttribute('aria-posinset', '1');
    expect(rows[1]).toHaveAttribute('aria-posinset', '2');
  });
});
