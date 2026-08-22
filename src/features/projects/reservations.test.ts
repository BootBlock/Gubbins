import { describe, expect, it } from 'vitest';
import { computeAvailabilityByItem, computeItemAvailability, type ReservationClaim } from './reservations';

/** A claim with sensible defaults, so each test states only what it is about. */
function claim(overrides: Partial<ReservationClaim> & Pick<ReservationClaim, 'lineId'>): ReservationClaim {
  return {
    itemId: 'item-1',
    projectId: 'project-1',
    projectName: 'Project',
    status: 'ACTUAL',
    reservedQty: 1,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('computeItemAvailability (issue #653)', () => {
  it('reports an unclaimed item as fully available', () => {
    const result = computeItemAvailability('item-1', 7);
    expect(result.availableQty).toBe(7);
    expect(result.reservedQty).toBe(0);
    expect(result.overCommittedQty).toBe(0);
    expect(result.claims).toEqual([]);
  });

  it('subtracts every claim from what is available', () => {
    const result = computeItemAvailability('item-1', 10, [
      claim({ lineId: 'a', reservedQty: 3 }),
      claim({ lineId: 'b', reservedQty: 2, status: 'TENTATIVE' }),
    ]);
    expect(result.actualQty).toBe(3);
    expect(result.tentativeQty).toBe(2);
    expect(result.reservedQty).toBe(5);
    expect(result.availableQty).toBe(5);
    expect(result.overCommittedQty).toBe(0);
  });

  it('never reports a negative availability when more is claimed than exists', () => {
    const result = computeItemAvailability('item-1', 4, [claim({ lineId: 'a', reservedQty: 9 })]);
    expect(result.availableQty).toBe(0);
    expect(result.overCommittedQty).toBe(5);
    expect(result.backingByLine.get('a')).toEqual({ lineId: 'a', backedQty: 4, unbackedQty: 5 });
  });

  it('backs the earlier claim in full and leaves the later one short', () => {
    // The reported failure: 10 on hand, 6 claimed by one project and 9 by another.
    const result = computeItemAvailability('item-1', 10, [
      claim({ lineId: 'later', projectId: 'p2', reservedQty: 9, createdAt: 2_000 }),
      claim({ lineId: 'earlier', projectId: 'p1', reservedQty: 6, createdAt: 1_000 }),
    ]);
    expect(result.backingByLine.get('earlier')).toEqual({
      lineId: 'earlier',
      backedQty: 6,
      unbackedQty: 0,
    });
    expect(result.backingByLine.get('later')).toEqual({ lineId: 'later', backedQty: 4, unbackedQty: 5 });
    expect(result.overCommittedQty).toBe(5);
  });

  it('serves a firm claim before a tentative one made earlier', () => {
    const result = computeItemAvailability('item-1', 4, [
      claim({ lineId: 'soft', status: 'TENTATIVE', reservedQty: 4, createdAt: 1_000 }),
      claim({ lineId: 'firm', status: 'ACTUAL', reservedQty: 4, createdAt: 5_000 }),
    ]);
    expect(result.backingByLine.get('firm')?.backedQty).toBe(4);
    expect(result.backingByLine.get('soft')?.backedQty).toBe(0);
  });

  it('breaks a same-instant tie by line id, so two devices allocate identically', () => {
    const inOneOrder = computeItemAvailability('item-1', 3, [
      claim({ lineId: 'bbb', reservedQty: 3 }),
      claim({ lineId: 'aaa', reservedQty: 3 }),
    ]);
    const inTheOther = computeItemAvailability('item-1', 3, [
      claim({ lineId: 'aaa', reservedQty: 3 }),
      claim({ lineId: 'bbb', reservedQty: 3 }),
    ]);
    expect(inOneOrder.backingByLine.get('aaa')?.backedQty).toBe(3);
    expect(inOneOrder.backingByLine.get('bbb')?.backedQty).toBe(0);
    expect([...inTheOther.backingByLine]).toEqual([...inOneOrder.backingByLine]);
  });

  it('backs every claim on an unlimited-supply item, and never calls it over-committed', () => {
    const result = computeItemAvailability(
      'item-1',
      2,
      [claim({ lineId: 'a', reservedQty: 500 }), claim({ lineId: 'b', reservedQty: 500 })],
      true,
    );
    expect(result.overCommittedQty).toBe(0);
    expect(result.backingByLine.get('b')?.backedQty).toBe(500);
    // Its on-hand figure is meaningless, so a claim never eats into it.
    expect(result.availableQty).toBe(2);
    expect(result.reservedQty).toBe(1_000);
  });

  it('floors a fractional claim and treats a negative on-hand as none', () => {
    const result = computeItemAvailability('item-1', -5, [claim({ lineId: 'a', reservedQty: 2.9 })]);
    expect(result.onHandQty).toBe(0);
    expect(result.reservedQty).toBe(2);
    expect(result.overCommittedQty).toBe(2);
  });
});

describe('computeAvailabilityByItem (issue #653)', () => {
  it('answers for every named item, claimed or not', () => {
    const result = computeAvailabilityByItem(
      [
        { itemId: 'a', onHandQty: 5, isUnlimited: false },
        { itemId: 'b', onHandQty: 2, isUnlimited: false },
      ],
      [claim({ lineId: 'l1', itemId: 'a', reservedQty: 4 })],
    );
    expect(result.get('a')?.availableQty).toBe(1);
    expect(result.get('b')?.availableQty).toBe(2);
    expect(result.get('b')?.claims).toEqual([]);
  });

  it('drops a claim against an item it was given no stock figure for', () => {
    // No on-hand figure means no pool to allocate; treating it as zero would report a
    // shortage against an item that may no longer exist.
    const result = computeAvailabilityByItem(
      [{ itemId: 'a', onHandQty: 5, isUnlimited: false }],
      [claim({ lineId: 'l1', itemId: 'gone', reservedQty: 4 })],
    );
    expect(result.size).toBe(1);
    expect(result.get('a')?.reservedQty).toBe(0);
  });

  it('keeps each item’s claims to itself', () => {
    const result = computeAvailabilityByItem(
      [
        { itemId: 'a', onHandQty: 1, isUnlimited: false },
        { itemId: 'b', onHandQty: 1, isUnlimited: false },
      ],
      [
        claim({ lineId: 'l1', itemId: 'a', reservedQty: 1 }),
        claim({ lineId: 'l2', itemId: 'b', reservedQty: 1 }),
      ],
    );
    expect(result.get('a')?.claims.map((c) => c.lineId)).toEqual(['l1']);
    expect(result.get('b')?.claims.map((c) => c.lineId)).toEqual(['l2']);
  });
});
