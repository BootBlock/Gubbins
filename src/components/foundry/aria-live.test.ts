import { describe, it, expect } from 'vitest';
import { liveRegionAttrs } from './aria-live';

describe('liveRegionAttrs — ARIA live-region politeness mapping (WCAG 4.1.3)', () => {
  it('maps polite to a status region that does not interrupt', () => {
    expect(liveRegionAttrs('polite')).toEqual({
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': true,
    });
  });

  it('maps assertive to an alert region that interrupts', () => {
    expect(liveRegionAttrs('assertive')).toEqual({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-atomic': true,
    });
  });

  it('always pairs an explicit aria-live with the matching role', () => {
    for (const urgency of ['polite', 'assertive'] as const) {
      const attrs = liveRegionAttrs(urgency);
      expect(attrs['aria-live']).toBe(urgency);
      expect(attrs.role).toBe(urgency === 'assertive' ? 'alert' : 'status');
    }
  });

  it('marks every region atomic so multi-part status is announced whole', () => {
    expect(liveRegionAttrs('polite')['aria-atomic']).toBe(true);
    expect(liveRegionAttrs('assertive')['aria-atomic']).toBe(true);
  });
});
