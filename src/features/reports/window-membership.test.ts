import { describe, expect, it } from 'vitest';

import { inTimeWindow, inTimeWindowEndInclusive } from './window-membership';

// A fixed, day-aligned window so the boundary instants are trivial to reason about.
const DAY = 86_400_000;
const START = 1_700_000_000_000;
const END = START + 10 * DAY;

/**
 * One boundary probe. `forward` is the expected `[start, end)` membership; `backward` is the
 * expected `(start, end]` membership. The pair is what a boundary transaction actually does to each
 * kind of report, so the table doubles as the specification of both conventions.
 */
interface Probe {
  readonly label: string;
  readonly instant: number;
  readonly forward: boolean;
  readonly backward: boolean;
}

const PROBES: readonly Probe[] = [
  { label: 'strictly before the window', instant: START - 1, forward: false, backward: false },
  { label: 'exactly on windowStart', instant: START, forward: true, backward: false },
  { label: 'one ms after windowStart', instant: START + 1, forward: true, backward: true },
  { label: 'strictly inside the window', instant: START + 5 * DAY, forward: true, backward: true },
  { label: 'one ms before windowEnd', instant: END - 1, forward: true, backward: true },
  { label: 'exactly on windowEnd', instant: END, forward: false, backward: true },
  { label: 'strictly after the window', instant: END + 1, forward: false, backward: false },
];

describe('window membership predicates', () => {
  describe.each(PROBES)('an instant $label', ({ instant, forward, backward }) => {
    it(`is ${forward ? '' : 'not '}in the forward [start, end) window`, () => {
      expect(inTimeWindow(instant, START, END)).toBe(forward);
    });

    it(`is ${backward ? '' : 'not '}in the backward (start, end] window`, () => {
      expect(inTimeWindowEndInclusive(instant, START, END)).toBe(backward);
    });
  });

  it('the two conventions are exact complements at the boundaries', () => {
    // The whole point of pairing them: forward and backward disagree *only* on the two edges, so a
    // boundary transaction is counted by exactly one convention, never both and never neither.
    for (const { instant } of PROBES) {
      if (instant === START || instant === END) {
        expect(inTimeWindow(instant, START, END)).not.toBe(inTimeWindowEndInclusive(instant, START, END));
      }
    }
  });

  it('the two conventions agree on every instant strictly inside the window', () => {
    for (const instant of [START + 1, START + 3 * DAY, START + 5 * DAY, END - 1]) {
      expect(inTimeWindow(instant, START, END)).toBe(true);
      expect(inTimeWindowEndInclusive(instant, START, END)).toBe(true);
    }
  });

  it('excludes everything for a collapsed (empty) window', () => {
    // A degenerate `end <= start` window has no interior; both predicates must reject the shared
    // instant rather than let a boundary event leak into a zero-width span.
    expect(inTimeWindow(START, START, START)).toBe(false);
    expect(inTimeWindowEndInclusive(START, START, START)).toBe(false);
  });
});
