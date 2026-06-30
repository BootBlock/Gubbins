import { describe, it, expect } from 'vitest';
import { summariseTurnover, type TurnoverInput } from './turnover';

/** Build a turnover input with sensible defaults the test can override. */
function input(over: Partial<TurnoverInput> = {}): TurnoverInput {
  return {
    id: 'i1',
    name: 'Widget',
    unitCost: 1,
    currentQty: 0,
    consumedUnits: 0,
    netQtyDelta: 0,
    ...over,
  };
}

describe('summariseTurnover — inventory turnover (COGS ÷ average on-hand value)', () => {
  it('computes the worked example (net outflow reconstructs the start quantity)', () => {
    // currentQty 10, netQtyDelta −40 ⇒ startQty 50, avgQty 30, cost 2 ⇒ avgValue 60.
    // consumedUnits 45 ⇒ cogs 90 ⇒ turnover 90/60 = 1.5.
    const report = summariseTurnover(
      [input({ unitCost: 2, currentQty: 10, netQtyDelta: -40, consumedUnits: 45 })],
      30,
    );
    expect(report.windowDays).toBe(30);
    const [line] = report.lines;
    expect(line.cogs).toBe(90);
    expect(line.avgValue).toBe(60);
    expect(line.turnover).toBe(1.5);
    // daysOnHand = windowDays * avgValue / cogs = 30 * 60 / 90 = 20.
    expect(line.daysOnHand).toBe(20);
    // Portfolio mirrors the single line.
    expect(report.totalCogs).toBe(90);
    expect(report.totalAvgValue).toBe(60);
    expect(report.turnover).toBe(1.5);
    expect(report.daysOnHand).toBe(20);
  });

  it('handles a net inflow case so the start quantity is below the current quantity', () => {
    // currentQty 30, netQtyDelta +10 ⇒ startQty 20, avgQty 25, cost 4 ⇒ avgValue 100.
    const report = summariseTurnover(
      [input({ unitCost: 4, currentQty: 30, netQtyDelta: 10, consumedUnits: 5 })],
      10,
    );
    const [line] = report.lines;
    expect(line.avgValue).toBe(100); // 25 * 4
    expect(line.cogs).toBe(20); // 5 * 4
    expect(line.turnover).toBeCloseTo(0.2, 10);
    expect(line.daysOnHand).toBeCloseTo((10 * 100) / 20, 10); // 50
  });

  it('returns null turnover (and no NaN) when the average value is zero', () => {
    // Unpriced item: cost 0 ⇒ avgValue 0 and cogs 0.
    const unpriced = summariseTurnover(
      [input({ unitCost: null, currentQty: 10, netQtyDelta: -5, consumedUnits: 8 })],
      30,
    );
    expect(unpriced.lines[0].avgValue).toBe(0);
    expect(unpriced.lines[0].turnover).toBeNull();
    expect(unpriced.lines[0].daysOnHand).toBeNull();
    expect(unpriced.turnover).toBeNull();
    expect(Number.isNaN(unpriced.turnover ?? 0)).toBe(false);

    // Zero stock at both ends but priced ⇒ avgValue 0 ⇒ turnover null.
    const empty = summariseTurnover(
      [input({ unitCost: 5, currentQty: 0, netQtyDelta: 0, consumedUnits: 0 })],
      30,
    );
    expect(empty.lines[0].avgValue).toBe(0);
    expect(empty.lines[0].turnover).toBeNull();
  });

  it('reports turnover 0 but null days-on-hand when nothing was consumed', () => {
    // Priced stock held, but consumedUnits 0 ⇒ cogs 0, avgValue > 0.
    const report = summariseTurnover(
      [input({ unitCost: 3, currentQty: 10, netQtyDelta: 0, consumedUnits: 0 })],
      30,
    );
    const [line] = report.lines;
    expect(line.cogs).toBe(0);
    expect(line.avgValue).toBe(30); // avgQty 10 * 3
    expect(line.turnover).toBe(0); // 0 / 30
    expect(line.daysOnHand).toBeNull(); // cogs 0 ⇒ no cover figure
    expect(report.daysOnHand).toBeNull();
  });

  it('clamps a reconstructed negative start quantity to zero', () => {
    // currentQty 0, netQtyDelta +100 ⇒ raw start −100, clamped to 0 ⇒ avgQty 0.
    const report = summariseTurnover(
      [input({ unitCost: 2, currentQty: 0, netQtyDelta: 100, consumedUnits: 3 })],
      30,
    );
    const [line] = report.lines;
    expect(line.avgValue).toBe(0); // avgQty 0 * cost
    expect(line.turnover).toBeNull();
    // cogs still reflects consumption even though average value is zero.
    expect(line.cogs).toBe(6);
  });

  it('clamps the window to at least one day and rounds it', () => {
    const sub = summariseTurnover(
      [input({ unitCost: 2, currentQty: 10, netQtyDelta: 0, consumedUnits: 10 })],
      0,
    );
    expect(sub.windowDays).toBe(1);
    // daysOnHand uses the clamped window: 1 * avgValue(20) / cogs(20) = 1.
    expect(sub.lines[0].daysOnHand).toBe(1);

    const rounded = summariseTurnover([input()], 9.6);
    expect(rounded.windowDays).toBe(10);
  });

  it('returns zero totals and null portfolio ratios for empty input', () => {
    const report = summariseTurnover([], 30);
    expect(report.lines).toEqual([]);
    expect(report.totalCogs).toBe(0);
    expect(report.totalAvgValue).toBe(0);
    expect(report.turnover).toBeNull();
    expect(report.daysOnHand).toBeNull();
  });

  it('sorts by turnover descending with nulls last, tie-breaking by cogs then name', () => {
    const report = summariseTurnover(
      [
        // turnover null (unpriced) — must sort last.
        input({ id: 'null', name: 'Zinc', unitCost: null, currentQty: 10, consumedUnits: 4 }),
        // turnover 1.0 each (cogs 100 vs cogs 50) — tie on turnover, cogs breaks it.
        input({ id: 'hi-cogs', name: 'Bravo', unitCost: 1, currentQty: 100, netQtyDelta: 0, consumedUnits: 100 }),
        input({ id: 'lo-cogs', name: 'Alpha', unitCost: 1, currentQty: 50, netQtyDelta: 0, consumedUnits: 50 }),
        // turnover 2.0 — highest, sorts first.
        input({ id: 'top', name: 'Charlie', unitCost: 1, currentQty: 10, netQtyDelta: 0, consumedUnits: 20 }),
      ],
      30,
    );
    expect(report.lines.map((l) => l.id)).toEqual(['top', 'hi-cogs', 'lo-cogs', 'null']);
  });

  it('breaks a full tie (equal turnover and cogs) by locale-aware name', () => {
    const report = summariseTurnover(
      [
        input({ id: 'b', name: 'Beta', unitCost: 1, currentQty: 10, netQtyDelta: 0, consumedUnits: 10 }),
        input({ id: 'a', name: 'Alpha', unitCost: 1, currentQty: 10, netQtyDelta: 0, consumedUnits: 10 }),
      ],
      30,
    );
    expect(report.lines.map((l) => l.name)).toEqual(['Alpha', 'Beta']);
  });

  it('aggregates portfolio totals and ratios across multiple items', () => {
    const report = summariseTurnover(
      [
        input({ id: 'a', name: 'A', unitCost: 2, currentQty: 10, netQtyDelta: -40, consumedUnits: 45 }), // cogs 90, avgValue 60
        input({ id: 'b', name: 'B', unitCost: 1, currentQty: 10, netQtyDelta: 0, consumedUnits: 0 }), // cogs 0, avgValue 10
      ],
      30,
    );
    expect(report.totalCogs).toBe(90);
    expect(report.totalAvgValue).toBe(70);
    expect(report.turnover).toBeCloseTo(90 / 70, 10);
    expect(report.daysOnHand).toBeCloseTo((30 * 70) / 90, 10);
  });

  it('falls back to the preferred supplier cost via the shared precedence seam', () => {
    const report = summariseTurnover(
      [input({ unitCost: null, preferredSupplierCost: 5, currentQty: 4, netQtyDelta: 0, consumedUnits: 2 })],
      30,
    );
    const [line] = report.lines;
    expect(line.cogs).toBe(10); // 2 * 5
    expect(line.avgValue).toBe(20); // avgQty 4 * 5
    expect(line.turnover).toBe(0.5);
  });
});
