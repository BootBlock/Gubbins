import { describe, it, expect } from 'vitest';
import { planReceipt, outstandingQty } from './receipts';

describe('planReceipt (spec §4 partial / split receipts)', () => {
  it('defaults an unspecified quantity to the full outstanding remainder', () => {
    const plan = planReceipt(5, 0);
    expect(plan).toEqual({
      receivedDelta: 5,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('receives an instalment smaller than the requirement, leaving the line open', () => {
    const plan = planReceipt(5, 0, 2);
    expect(plan).toEqual({
      receivedDelta: 2,
      nextReceivedQty: 2,
      outstandingQty: 3,
      fullyReceived: false,
    });
  });

  it('accumulates onto an earlier instalment, completing the line', () => {
    // 2 already received; receiving the remaining 3 completes it.
    const plan = planReceipt(5, 2, 3);
    expect(plan).toEqual({
      receivedDelta: 3,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('clamps an over-receipt to the outstanding remainder (never overshoots)', () => {
    // Only 3 outstanding; asking for 10 accepts just 3.
    const plan = planReceipt(5, 2, 10);
    expect(plan).toEqual({
      receivedDelta: 3,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('floors fractional and rejects negative requested quantities', () => {
    expect(planReceipt(5, 0, 2.9).receivedDelta).toBe(2);
    const negative = planReceipt(5, 0, -4);
    expect(negative.receivedDelta).toBe(0);
    expect(negative.nextReceivedQty).toBe(0);
    expect(negative.fullyReceived).toBe(false);
  });

  it('is a no-op once the line is already fully received', () => {
    const plan = planReceipt(5, 5, 3);
    expect(plan).toEqual({
      receivedDelta: 0,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('treats a zero-requirement line as immediately complete', () => {
    expect(planReceipt(0, 0)).toEqual({
      receivedDelta: 0,
      nextReceivedQty: 0,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });
});

describe('outstandingQty', () => {
  it('is the requirement less what has already arrived, floored at zero', () => {
    expect(outstandingQty({ requiredQty: 5, receivedQty: 0 })).toBe(5);
    expect(outstandingQty({ requiredQty: 5, receivedQty: 2 })).toBe(3);
    expect(outstandingQty({ requiredQty: 5, receivedQty: 5 })).toBe(0);
    // Defensive: a received figure beyond the requirement never goes negative.
    expect(outstandingQty({ requiredQty: 5, receivedQty: 7 })).toBe(0);
  });
});
