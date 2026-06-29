import { describe, it, expect } from 'vitest';
import { planTransfer, totalOnHand, activePlacements, type StockPlacement } from './stock';

describe('planTransfer', () => {
  it('moves the requested quantity when stock allows', () => {
    expect(planTransfer(10, 4)).toEqual({ quantity: 4, ok: true, clamped: false });
  });

  it('clamps the request to the available stock', () => {
    expect(planTransfer(3, 10)).toEqual({ quantity: 3, ok: true, clamped: true });
  });

  it('floors a fractional request to a whole unit', () => {
    expect(planTransfer(10, 2.9)).toEqual({ quantity: 2, ok: true, clamped: false });
  });

  it('refuses a non-positive request', () => {
    expect(planTransfer(10, 0)).toEqual({ quantity: 0, ok: false, clamped: false });
    expect(planTransfer(10, -5)).toEqual({ quantity: 0, ok: false, clamped: false });
  });

  it('refuses a transfer out of an empty location', () => {
    expect(planTransfer(0, 5)).toEqual({ quantity: 0, ok: false, clamped: true });
  });

  it('guards non-finite inputs', () => {
    expect(planTransfer(Number.NaN, 5)).toEqual({ quantity: 0, ok: false, clamped: true });
    expect(planTransfer(10, Number.NaN)).toEqual({ quantity: 0, ok: false, clamped: false });
  });
});

describe('totalOnHand / activePlacements', () => {
  const placements: StockPlacement[] = [
    { locationId: 'b', locationName: 'Drawer B', quantity: 40 },
    { locationId: 'a', locationName: 'Drawer A', quantity: 60 },
    { locationId: 'c', locationName: 'Bin C', quantity: 0 },
  ];

  it('sums every placement', () => {
    expect(totalOnHand(placements)).toBe(100);
  });

  it('drops empty placements and orders busiest first', () => {
    const active = activePlacements(placements);
    expect(active.map((p) => p.locationId)).toEqual(['a', 'b']);
  });
});
