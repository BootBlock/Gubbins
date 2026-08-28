import { describe, it, expect } from 'vitest';
import {
  CONDITION_COLOR_CLASS,
  CONDITION_LABELS,
  WARRANTY_STATUS_COLOR_CLASS,
  WARRANTY_STATUS_LABEL,
  gaugeTone,
} from './inventory-ui';
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

/**
 * Drift guard (issue #254). `WARRANTY_STATUS_COLOR_CLASS`'s docstring says it mirrors
 * `CONDITION_COLOR_CLASS` — "green for active down to red for expired". Two maps over
 * different enums cannot be held together by their keys, so what is asserted is the thing the
 * claim actually means: each severity rank is painted with the *same* token in both, so a
 * "bad" warranty and a "bad" condition never read as two different degrees of bad on one screen.
 *
 * The second half is the token rule from CLAUDE.md, checked rather than trusted: every entry is
 * a semantic `text-*` token, never a raw colour or a Tailwind palette class. An unknown utility
 * emits no CSS and fails silently, so a palette class slipped in here would simply render
 * untinted.
 */
describe('warranty ↔ condition colour parity (issue #254)', () => {
  /** The same three severity ranks, named on each side by the state that carries them. */
  const RANKS = [
    { rank: 'good', condition: 'MINT', warranty: 'active' },
    { rank: 'attention', condition: 'OUT_FOR_CALIBRATION', warranty: 'expiring-soon' },
    { rank: 'bad', condition: 'NEEDS_REPAIR', warranty: 'expired' },
  ] as const;

  it.each(RANKS)('paints the $rank rank with one token on both sides', ({ condition, warranty }) => {
    expect(WARRANTY_STATUS_COLOR_CLASS[warranty]).toBe(CONDITION_COLOR_CLASS[condition]);
  });

  it('uses only semantic text tokens, never a raw colour or palette class', () => {
    const entries = [...Object.values(CONDITION_COLOR_CLASS), ...Object.values(WARRANTY_STATUS_COLOR_CLASS)];
    for (const cls of entries) {
      expect(cls).toMatch(/^text-[a-z-]+$/);
      // `text-red-500` and friends: a palette class is a numbered scale step.
      expect(cls).not.toMatch(/-\d+$/);
    }
  });

  it('gives every state a label, so colour is never the sole signal (WCAG 1.4.1)', () => {
    for (const state of Object.keys(WARRANTY_STATUS_COLOR_CLASS)) {
      expect(WARRANTY_STATUS_LABEL[state as keyof typeof WARRANTY_STATUS_LABEL]).toBeTruthy();
    }
    for (const state of Object.keys(CONDITION_COLOR_CLASS)) {
      expect(CONDITION_LABELS[state as keyof typeof CONDITION_LABELS]).toBeTruthy();
    }
  });
});
