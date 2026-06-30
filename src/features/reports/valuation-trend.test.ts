import { describe, expect, it } from 'vitest';

import { buildValuationTrend, type ValuationEvent } from './valuation-trend';

// A fixed, day-aligned window so boundary instants are easy to reason about in assertions.
const DAY = 86_400_000;
const START = 1_700_000_000_000;
const END = START + 10 * DAY;

describe('buildValuationTrend', () => {
  it('draws a flat line at currentValue when there are no events', () => {
    const report = buildValuationTrend(1_000, [], START, END, 5);

    expect(report.points).toHaveLength(5);
    for (const point of report.points) {
      expect(point.value).toBe(1_000);
    }
    expect(report.startValue).toBe(1_000);
    expect(report.endValue).toBe(1_000);
    expect(report.changeValue).toBe(0);
  });

  it('emits inclusive, evenly-spaced boundaries pinned to the window ends', () => {
    const report = buildValuationTrend(0, [], START, END, 5);

    expect(report.points.map((p) => p.at)).toEqual([
      START,
      START + 2.5 * DAY,
      START + 5 * DAY,
      START + 7.5 * DAY,
      END,
    ]);
    expect(report.points[0]?.at).toBe(report.windowStart);
    expect(report.points[report.points.length - 1]?.at).toBe(report.windowEnd);
  });

  it('lowers boundaries before a positive mid-window event, leaving later ones at currentValue', () => {
    // Value rose by 300 halfway through: the past was worth 300 less.
    const events: ValuationEvent[] = [{ createdAt: START + 5 * DAY, valueDelta: 300 }];
    const report = buildValuationTrend(1_000, events, START, END, 5);

    // The event sits exactly on points[2] (START + 5d). It is NOT "after" that boundary, so
    // points[2] is unaffected; only the strictly-earlier points[0] and points[1] drop by 300.
    expect(report.points.map((p) => p.value)).toEqual([700, 700, 1_000, 1_000, 1_000]);
    expect(report.startValue).toBe(700); // currentValue − valueDelta
    expect(report.endValue).toBe(1_000); // == currentValue
    expect(report.changeValue).toBe(300);
  });

  it('reconstructs a higher past value when a negative event reduced value over time', () => {
    // Value fell by 400 mid-window (e.g. stock consumed): the past was worth 400 more.
    const events: ValuationEvent[] = [{ createdAt: START + 5 * DAY, valueDelta: -400 }];
    const report = buildValuationTrend(1_000, events, START, END, 5);

    expect(report.points.map((p) => p.value)).toEqual([1_400, 1_400, 1_000, 1_000, 1_000]);
    expect(report.startValue).toBe(1_400);
    expect(report.endValue).toBe(1_000);
    expect(report.changeValue).toBe(-400);
  });

  it('clamps a reconstructed value to >= 0 when a large positive delta would drive it negative', () => {
    // currentValue 100 but value rose by 1000 mid-window → naive past value = −900, clamped to 0.
    const events: ValuationEvent[] = [{ createdAt: START + 5 * DAY, valueDelta: 1_000 }];
    const report = buildValuationTrend(100, events, START, END, 5);

    expect(report.points.map((p) => p.value)).toEqual([0, 0, 100, 100, 100]);
    expect(report.startValue).toBe(0);
    expect(report.endValue).toBe(100);
  });

  it('ignores events outside the window on both edges', () => {
    const events: ValuationEvent[] = [
      { createdAt: START - DAY, valueDelta: 500 }, // before windowStart
      { createdAt: START, valueDelta: 500 }, // exactly at windowStart (not strictly after any boundary)
      { createdAt: END + DAY, valueDelta: 500 }, // strictly after windowEnd
    ];
    const report = buildValuationTrend(1_000, events, START, END, 5);

    for (const point of report.points) {
      expect(point.value).toBe(1_000);
    }
    expect(report.changeValue).toBe(0);
  });

  it('treats an event exactly on windowEnd as in-window but not "after" the final boundary', () => {
    // createdAt === windowEnd is <= windowEnd (in-window). It is NOT strictly after the final
    // boundary (also windowEnd), so points[last] stays at currentValue; but it IS strictly after
    // every earlier boundary, so those reconstruct 250 lower.
    const events: ValuationEvent[] = [{ createdAt: END, valueDelta: 250 }];
    const report = buildValuationTrend(1_000, events, START, END, 5);

    expect(report.points.map((p) => p.value)).toEqual([750, 750, 750, 750, 1_000]);
    expect(report.endValue).toBe(1_000);
  });

  it('clamps points to a minimum of two', () => {
    const one = buildValuationTrend(500, [], START, END, 1);
    expect(one.points).toHaveLength(2);
    expect(one.points.map((p) => p.at)).toEqual([START, END]);

    const zero = buildValuationTrend(500, [], START, END, 0);
    expect(zero.points).toHaveLength(2);

    const fractional = buildValuationTrend(500, [], START, END, 3.9);
    expect(fractional.points).toHaveLength(3); // floored
  });

  it('produces five chronological boundaries with correct spacing for points = 5', () => {
    const report = buildValuationTrend(0, [], START, END, 5);
    const ats = report.points.map((p) => p.at);

    expect(ats).toHaveLength(5);
    for (let i = 1; i < ats.length; i += 1) {
      expect(ats[i]).toBeGreaterThan(ats[i - 1] ?? -Infinity);
    }
  });

  it('always ends at the clamped currentValue', () => {
    const positiveReport = buildValuationTrend(750, [{ createdAt: START + 2 * DAY, valueDelta: 100 }], START, END, 4);
    expect(positiveReport.endValue).toBe(750);
    expect(positiveReport.points[positiveReport.points.length - 1]?.value).toBe(750);

    // A negative currentValue (degenerate cost data) is itself clamped at the end.
    const negativeReport = buildValuationTrend(-50, [], START, END, 4);
    expect(negativeReport.endValue).toBe(0);
  });

  it('accumulates multiple in-window events across distinct boundaries', () => {
    const events: ValuationEvent[] = [
      { createdAt: START + 2.5 * DAY, valueDelta: 100 }, // on points[1]
      { createdAt: START + 7.5 * DAY, valueDelta: 200 }, // on points[3]
    ];
    const report = buildValuationTrend(1_000, events, START, END, 5);

    // points[0]: both events are after it → −300; points[1]: only the +200 event after → −200;
    // points[2]: only the +200 event after → −200; points[3]: nothing after → 0; points[4]: 0.
    expect(report.points.map((p) => p.value)).toEqual([700, 800, 800, 1_000, 1_000]);
    expect(report.endValue).toBe(1_000);
  });

  it('handles a degenerate window without throwing or yielding NaN', () => {
    const events: ValuationEvent[] = [{ createdAt: START, valueDelta: 100 }];
    const report = buildValuationTrend(500, events, START, START, 5);

    expect(report.points).toHaveLength(5);
    for (const point of report.points) {
      expect(Number.isNaN(point.value)).toBe(false);
      expect(point.at).toBe(START);
      expect(point.value).toBe(500); // flat: no event is strictly after the collapsed instant
    }
    expect(report.changeValue).toBe(0);
  });

  it('handles an inverted window (windowEnd < windowStart) without NaN', () => {
    const report = buildValuationTrend(500, [], START, START - 5 * DAY, 4);

    expect(report.points).toHaveLength(4);
    for (const point of report.points) {
      expect(Number.isNaN(point.value)).toBe(false);
      expect(point.value).toBe(500);
    }
  });

  it('is order-independent in its event input', () => {
    const ordered: ValuationEvent[] = [
      { createdAt: START + 2 * DAY, valueDelta: 50 },
      { createdAt: START + 6 * DAY, valueDelta: -75 },
      { createdAt: START + 8 * DAY, valueDelta: 120 },
    ];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];

    const a = buildValuationTrend(1_000, ordered, START, END, 6);
    const b = buildValuationTrend(1_000, shuffled, START, END, 6);

    expect(b.points).toEqual(a.points);
  });
});
