import { describe, it, expect } from 'vitest';
import { formatBytes, formatPercent } from './format';

describe('formatBytes', () => {
  it('formats zero and negative values as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('formats with decimal (SI) units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1500)).toBe('1.5 kB');
    expect(formatBytes(2_000_000)).toBe('2 MB');
    expect(formatBytes(3_500_000_000)).toMatch(/GB$/);
  });

  it('handles non-finite input', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatPercent', () => {
  it('formats a 0..1 ratio as a percentage', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('clamps out-of-range and non-finite ratios', () => {
    expect(formatPercent(1.5)).toBe('100%');
    expect(formatPercent(-0.2)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});
