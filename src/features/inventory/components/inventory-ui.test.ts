import { describe, it, expect } from 'vitest';
import { gaugeTone } from './inventory-ui';
// Locale-aware number/measure/date formatting now lives in the `makeFormatters`
// factory and is covered by `src/lib/format.test.ts`.

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
