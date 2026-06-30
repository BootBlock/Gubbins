import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories';
import {
  buildAbcCsv,
  buildAgingCsv,
  buildConsumptionCsv,
  buildDataHygieneCsv,
  buildDeadStockCsv,
  buildMovementCsv,
  buildTurnoverCsv,
  buildValuationCsv,
  buildValuationTrendCsv,
} from './report-csv';
import { buildHygieneReport } from './data-hygiene';

describe('report CSV builders', () => {
  it('valuation CSV tags each row by dimension and quotes names with commas', () => {
    const csv = buildValuationCsv({
      totalValue: 30,
      totalQuantity: 15,
      unpricedItemCount: 0,
      byCategory: [{ id: 'a', name: 'Caps, big', value: 30, quantity: 15 }],
      byLocation: [{ id: 'l', name: 'Shelf', value: 30, quantity: 15 }],
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('dimension,group,quantity,value');
    expect(lines[1]).toBe('Category,"Caps, big",15,30');
    expect(lines[2]).toBe('Location,Shelf,15,30');
  });

  it('consumption CSV emits a single summary row with ISO window dates', () => {
    const csv = buildConsumptionCsv({
      windowStart: 0,
      windowEnd: 10 * MS_PER_DAY,
      windowDays: 10,
      totalConsumed: 50,
      perDay: 5,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('windowStart,windowEnd,windowDays,totalConsumed,perDay');
    expect(lines[1]).toBe('1970-01-01,1970-01-11,10,50,5');
  });

  it('movement CSV emits one row per bucket plus a totals row', () => {
    const csv = buildMovementCsv({
      windowStart: 0,
      windowEnd: 2 * MS_PER_DAY,
      buckets: [
        { start: 0, end: MS_PER_DAY, in: 4, out: 1 },
        { start: MS_PER_DAY, end: 2 * MS_PER_DAY, in: 0, out: 3 },
      ],
      totalIn: 4,
      totalOut: 4,
    });
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4); // header + 2 buckets + total
    expect(lines[3]).toBe('Total,,4,4');
  });

  it('dead-stock CSV emits one row per idle line', () => {
    const csv = buildDeadStockCsv({
      sinceDays: 30,
      lines: [{ id: 'a', name: 'Idle', quantity: 4, idleDays: 90, value: 20 }],
      totalValue: 20,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item,quantity,idleDays,value');
    expect(lines[1]).toBe('Idle,4,90,20');
  });

  // Phase 74 — advanced-analytics CSVs ------------------------------------------
  it('ABC CSV emits one row per ranked line with its tier and cumulative share', () => {
    const csv = buildAbcCsv({
      lines: [
        { id: 'a', name: 'Big', annualValue: 80, cumulativeShare: 0.8, tier: 'A' },
        { id: 'b', name: 'Small', annualValue: 20, cumulativeShare: 1, tier: 'C' },
      ],
      tiers: {
        A: { tier: 'A', itemCount: 1, totalValue: 80, valueShare: 0.8 },
        B: { tier: 'B', itemCount: 0, totalValue: 0, valueShare: 0 },
        C: { tier: 'C', itemCount: 1, totalValue: 20, valueShare: 0.2 },
      },
      totalValue: 100,
      thresholds: { aCutoff: 0.8, bCutoff: 0.95 },
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('tier,item,annualValue,cumulativeShare');
    expect(lines[1]).toBe('A,Big,80,0.8');
    expect(lines[2]).toBe('C,Small,20,1');
  });

  it('turnover CSV emits one row per line plus a portfolio total (null ratios blank)', () => {
    const csv = buildTurnoverCsv({
      windowDays: 90,
      lines: [{ id: 'a', name: 'Cycler', cogs: 80, avgValue: 40, turnover: 2, daysOnHand: 45 }],
      totalCogs: 80,
      totalAvgValue: 40,
      turnover: 2,
      daysOnHand: 45,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item,cogs,avgValue,turnover,daysOnHand');
    expect(lines[1]).toBe('Cycler,80,40,2,45');
    expect(lines[2]).toBe('Total,80,40,2,45');
  });

  it('aging CSV emits one row per bucket', () => {
    const csv = buildAgingCsv({
      now: 0,
      buckets: [
        { label: '0–30 days', minDays: 0, maxDays: 30, itemCount: 2, quantity: 5, value: 50 },
        { label: '180+ days', minDays: 181, maxDays: null, itemCount: 1, quantity: 3, value: 9 },
      ],
      totalQuantity: 8,
      totalValue: 59,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('bucket,itemCount,quantity,value');
    expect(lines[1]).toBe('0–30 days,2,5,50');
    expect(lines[2]).toBe('180+ days,1,3,9');
  });

  it('valuation-trend CSV emits one dated row per sample', () => {
    const csv = buildValuationTrendCsv({
      windowStart: 0,
      windowEnd: MS_PER_DAY,
      points: [
        { at: 0, value: 30 },
        { at: MS_PER_DAY, value: 20 },
      ],
      startValue: 30,
      endValue: 20,
      changeValue: -10,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('date,value');
    expect(lines[1]).toBe('1970-01-01,30');
    expect(lines[2]).toBe('1970-01-02,20');
  });

  it('data-hygiene CSV lists per-check totals then the sampled detail rows', () => {
    const report = buildHygieneReport(
      [
        { id: 'a', name: 'No category', mpn: null, hasCategory: false, hasLocation: true, hasPrice: true, hasPhoto: true, everCounted: true, lastActivityAt: 0 },
      ],
      { now: 0, staleDays: 180 },
    );
    const csv = buildDataHygieneCsv(report);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('row,issue,item,detail');
    // A summary row per check, including the failing one with count 1.
    expect(lines).toContain('summary,Missing category,1,');
    // The detail row for the flagged item.
    expect(lines).toContain('item,Missing category,No category,');
  });
});
