import { describe, it, expect } from 'vitest';
import { derivePoStatus } from './po-status';

describe('derivePoStatus', () => {
  it('returns DRAFT unchanged regardless of line progress', () => {
    expect(derivePoStatus('DRAFT', [{ orderedQty: 5, receivedQty: 5 }])).toBe('DRAFT');
    expect(derivePoStatus('DRAFT', [])).toBe('DRAFT');
  });

  it('returns CANCELLED unchanged regardless of line progress', () => {
    expect(derivePoStatus('CANCELLED', [{ orderedQty: 5, receivedQty: 5 }])).toBe('CANCELLED');
    expect(derivePoStatus('CANCELLED', [])).toBe('CANCELLED');
  });

  it('derives ORDERED when nothing has been received', () => {
    expect(derivePoStatus('ORDERED', [{ orderedQty: 10, receivedQty: 0 }])).toBe('ORDERED');
    expect(
      derivePoStatus('PARTIAL', [
        { orderedQty: 3, receivedQty: 0 },
        { orderedQty: 7, receivedQty: 0 },
      ]),
    ).toBe('ORDERED');
  });

  it('derives PARTIAL when some but not all units have arrived', () => {
    expect(derivePoStatus('ORDERED', [{ orderedQty: 10, receivedQty: 4 }])).toBe('PARTIAL');
    expect(
      derivePoStatus('ORDERED', [
        { orderedQty: 5, receivedQty: 5 },
        { orderedQty: 5, receivedQty: 0 },
      ]),
    ).toBe('PARTIAL');
  });

  it('derives RECEIVED when every line is fully received', () => {
    expect(derivePoStatus('PARTIAL', [{ orderedQty: 10, receivedQty: 10 }])).toBe('RECEIVED');
    expect(
      derivePoStatus('ORDERED', [
        { orderedQty: 5, receivedQty: 5 },
        { orderedQty: 2, receivedQty: 2 },
      ]),
    ).toBe('RECEIVED');
  });

  it('treats an over-received line as fully received (clamped), not over', () => {
    expect(derivePoStatus('ORDERED', [{ orderedQty: 4, receivedQty: 9 }])).toBe('RECEIVED');
  });

  it('treats a past-DRAFT order with no lines as ORDERED', () => {
    expect(derivePoStatus('ORDERED', [])).toBe('ORDERED');
    expect(derivePoStatus('RECEIVED', [])).toBe('ORDERED');
  });

  it('treats a past-DRAFT order whose only line is zero-ordered as ORDERED', () => {
    expect(derivePoStatus('ORDERED', [{ orderedQty: 0, receivedQty: 0 }])).toBe('ORDERED');
  });
});
