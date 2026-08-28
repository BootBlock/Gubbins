/**
 * Drift guard (issue #254). `GAUGE_TARE_EDIT_HINT`'s docstring says it is "identical to
 * `GAUGE_TARE_HINT` up to the last sentence" — a parity claim between two string literals that
 * nothing compared, in a module whose whole reason for existing is that the add and edit paths
 * must explain one column the same way.
 *
 * The two are deliberately *not* built from a shared prefix constant: the copy reads as copy at
 * the point of definition, which is what makes it reviewable. That choice is what leaves the
 * claim unenforced, so this asserts it instead — the shared explanation is byte-identical, and
 * only the closing sentence differs.
 */
import { describe, expect, it } from 'vitest';
import {
  GAUGE_ATTRITION_HINT,
  GAUGE_CAPACITY_HINT,
  GAUGE_TARE_EDIT_HINT,
  GAUGE_TARE_HINT,
  GAUGE_UNIT_HINT,
  gaugeCostHint,
} from './gauge-field-copy';

/** The explanation both tare hints owe the user before they diverge. */
const SHARED_TARE_LEAD =
  'The weight of the **empty container** (the spool, bottle or reel). Subtracted from a ' +
  'measured gross weight so the gauge reflects only the *usable contents*.';

describe('gauge tare copy parity (issue #254)', () => {
  it('opens both tare hints with the same explanation, byte for byte', () => {
    expect(GAUGE_TARE_HINT.startsWith(SHARED_TARE_LEAD)).toBe(true);
    expect(GAUGE_TARE_EDIT_HINT.startsWith(SHARED_TARE_LEAD)).toBe(true);
  });

  it('differs only in the closing sentence, which is the one an edit raises', () => {
    expect(GAUGE_TARE_EDIT_HINT).not.toBe(GAUGE_TARE_HINT);
    // Everything after the shared lead is one sentence on each side, and only that differs.
    const tail = (hint: string) => hint.slice(SHARED_TARE_LEAD.length).trim();
    expect(tail(GAUGE_TARE_HINT)).toBe('Use `0` if not weighing.');
    expect(tail(GAUGE_TARE_EDIT_HINT)).toBe(
      'Changing it re-scales future weigh-ins; it does not change how much is in the gauge now.',
    );
  });
});

describe('gauge field copy', () => {
  it('gives every field non-empty hint text', () => {
    for (const hint of [
      GAUGE_UNIT_HINT,
      GAUGE_CAPACITY_HINT,
      GAUGE_TARE_HINT,
      GAUGE_TARE_EDIT_HINT,
      GAUGE_ATTRITION_HINT,
      gaugeCostHint('g'),
    ]) {
      expect(hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('names the gauge’s own unit in the cost hint rather than leaving it to be inferred', () => {
    expect(gaugeCostHint('ml')).toContain('**one ml**');
    expect(gaugeCostHint('g')).toContain('**one g**');
  });
});
