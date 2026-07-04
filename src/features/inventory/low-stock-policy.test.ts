import { describe, it, expect } from 'vitest';
import { policyFromValue, valueForPolicy, type LowStockPolicy } from './low-stock-policy';

describe('low-stock-policy — policyFromValue', () => {
  it('maps null/undefined to "default" (follow the global blanket)', () => {
    expect(policyFromValue(null)).toBe('default');
    expect(policyFromValue(undefined)).toBe('default');
  });

  it('maps 0 (and any non-positive) to "never" (hard exemption)', () => {
    expect(policyFromValue(0)).toBe('never');
    expect(policyFromValue(-1)).toBe('never');
  });

  it('maps a positive floor to "custom"', () => {
    expect(policyFromValue(1)).toBe('custom');
    expect(policyFromValue(20)).toBe('custom');
  });
});

describe('low-stock-policy — valueForPolicy', () => {
  it('default → null (clears the override)', () => {
    expect(valueForPolicy('default', 5)).toBeNull();
    expect(valueForPolicy('default', null)).toBeNull();
  });

  it('never → 0 (hard exemption), ignoring any custom value', () => {
    expect(valueForPolicy('never', 5)).toBe(0);
    expect(valueForPolicy('never', null)).toBe(0);
  });

  it('custom → the entered value verbatim (null when blank)', () => {
    expect(valueForPolicy('custom', 20)).toBe(20);
    expect(valueForPolicy('custom', null)).toBeNull();
  });

  it('round-trips a stored value back to itself through its policy', () => {
    for (const stored of [null, 0, 3, 20] as const) {
      const policy: LowStockPolicy = policyFromValue(stored);
      const custom = policy === 'custom' ? stored : null;
      expect(valueForPolicy(policy, custom)).toBe(stored);
    }
  });
});
