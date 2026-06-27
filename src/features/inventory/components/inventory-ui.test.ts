import { describe, it, expect } from 'vitest';
import { formatMeasure, formatQuantity, gaugeTone } from './inventory-ui';

describe('gaugeTone (§4.1.3 colour bands)', () => {
  it('is green above 50%', () => {
    expect(gaugeTone(80).fill).toBe('bg-success');
    expect(gaugeTone(50).fill).toBe('bg-success');
  });

  it('is amber between 15% and 50%', () => {
    expect(gaugeTone(49).fill).toBe('bg-warning');
    expect(gaugeTone(15).fill).toBe('bg-warning');
  });

  it('is crimson below 15%', () => {
    expect(gaugeTone(14).fill).toBe('bg-destructive');
    expect(gaugeTone(0).fill).toBe('bg-destructive');
  });
});

describe('en-GB formatting (§1.2.1)', () => {
  it('groups large quantities', () => {
    expect(formatQuantity(12500)).toBe('12,500');
  });

  it('trims gauge decimals and appends the unit', () => {
    expect(formatMeasure(399.999, 'g')).toBe('400g');
    expect(formatMeasure(45.5, 'ml')).toBe('45.5ml');
  });
});
