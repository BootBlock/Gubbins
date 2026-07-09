import { describe, it, expect } from 'vitest';
import { planPoReceipt, planPoReturn } from './po-receipt';

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

describe('planPoReturn', () => {
  it('returns everything received when no quantity is requested', () => {
    const plan = planPoReturn(10);
    expect(plan.returnedDelta).toBe(10);
    expect(plan.nextReceivedQty).toBe(0);
  });

  it('returns a partial instalment and leaves the rest received', () => {
    const plan = planPoReturn(10, 4);
    expect(plan.returnedDelta).toBe(4);
    expect(plan.nextReceivedQty).toBe(6);
  });

  it('clamps a return to what was received', () => {
    const plan = planPoReturn(6, 99);
    expect(plan.returnedDelta).toBe(6);
    expect(plan.nextReceivedQty).toBe(0);
  });

  it('floors a fractional request and never goes negative', () => {
    expect(planPoReturn(10, 3.9).returnedDelta).toBe(3);
    expect(planPoReturn(10, -5).returnedDelta).toBe(0);
  });

  it('returns nothing when nothing was received', () => {
    const plan = planPoReturn(0);
    expect(plan.returnedDelta).toBe(0);
    expect(plan.nextReceivedQty).toBe(0);
  });
});
