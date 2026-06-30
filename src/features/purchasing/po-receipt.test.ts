import { describe, it, expect } from 'vitest';
import { planPoReceipt } from './po-receipt';

describe('planPoReceipt', () => {
  it('receives the whole outstanding remainder when no quantity is requested', () => {
    const plan = planPoReceipt(10, 0);
    expect(plan.receivedDelta).toBe(10);
    expect(plan.nextReceivedQty).toBe(10);
    expect(plan.outstandingQty).toBe(0);
    expect(plan.fullyReceived).toBe(true);
  });

  it('receives a partial instalment and stays open', () => {
    const plan = planPoReceipt(10, 0, 4);
    expect(plan.receivedDelta).toBe(4);
    expect(plan.nextReceivedQty).toBe(4);
    expect(plan.outstandingQty).toBe(6);
    expect(plan.fullyReceived).toBe(false);
  });

  it('accumulates onto prior receipts', () => {
    const plan = planPoReceipt(10, 4, 6);
    expect(plan.receivedDelta).toBe(6);
    expect(plan.nextReceivedQty).toBe(10);
    expect(plan.outstandingQty).toBe(0);
    expect(plan.fullyReceived).toBe(true);
  });

  it('clamps an overshoot to the outstanding remainder', () => {
    const plan = planPoReceipt(10, 7, 99);
    expect(plan.receivedDelta).toBe(3);
    expect(plan.nextReceivedQty).toBe(10);
    expect(plan.fullyReceived).toBe(true);
  });

  it('floors a fractional request and never goes negative', () => {
    expect(planPoReceipt(10, 0, 3.9).receivedDelta).toBe(3);
    expect(planPoReceipt(10, 0, -5).receivedDelta).toBe(0);
  });

  it('receives nothing once fully received', () => {
    const plan = planPoReceipt(5, 5);
    expect(plan.receivedDelta).toBe(0);
    expect(plan.fullyReceived).toBe(true);
  });
});
