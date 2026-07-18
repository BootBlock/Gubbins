import { describe, expect, it } from 'vitest';
import {
  CLOSE_DEVIATION_UNITS,
  EXACT_DEVIATION_UNITS,
  classifyDeviation,
  countFromWeight,
  resolveWeighCount,
  weighCountNote,
} from './weigh-count';

describe('countFromWeight', () => {
  it('counts the issue #101 worked example — 43 g of 0.5 g screws is 86 units', () => {
    const result = countFromWeight({ grossGrams: 43, unitWeightGrams: 0.5 });
    expect(result).not.toBeNull();
    expect(result!.count).toBe(86);
    expect(result!.netGrams).toBe(43);
    expect(result!.confidence).toBe('exact');
  });

  it('subtracts the tare before dividing', () => {
    // 120 g gross in a 20 g tray of 2 g parts → 100 g net → 50 units.
    const result = countFromWeight({ grossGrams: 120, tareGrams: 20, unitWeightGrams: 2 });
    expect(result!.netGrams).toBe(100);
    expect(result!.count).toBe(50);
  });

  it('rounds to the nearest whole unit and reports the deviation', () => {
    // 10.4 g of 1 g parts → 10.4 units → 10, off by 0.4 of a unit.
    const result = countFromWeight({ grossGrams: 10.4, unitWeightGrams: 1 });
    expect(result!.count).toBe(10);
    expect(result!.exactUnits).toBeCloseTo(10.4, 10);
    expect(result!.deviationUnits).toBeCloseTo(0.4, 10);
  });

  it('clamps a tare heavier than the reading to an empty scale rather than a negative count', () => {
    const result = countFromWeight({ grossGrams: 5, tareGrams: 20, unitWeightGrams: 1 });
    expect(result!.netGrams).toBe(0);
    expect(result!.count).toBe(0);
    expect(result!.confidence).toBe('exact');
  });

  it('returns null when the per-unit weight cannot support a division', () => {
    expect(countFromWeight({ grossGrams: 43, unitWeightGrams: 0 })).toBeNull();
    expect(countFromWeight({ grossGrams: 43, unitWeightGrams: -1 })).toBeNull();
    expect(countFromWeight({ grossGrams: 43, unitWeightGrams: Number.NaN })).toBeNull();
  });

  it('returns null for a non-finite reading or tare', () => {
    expect(countFromWeight({ grossGrams: Number.NaN, unitWeightGrams: 1 })).toBeNull();
    expect(countFromWeight({ grossGrams: 10, tareGrams: Number.NaN, unitWeightGrams: 1 })).toBeNull();
  });
});

describe('classifyDeviation', () => {
  it('bands a reading that lands on a whole unit as exact', () => {
    expect(classifyDeviation(0)).toBe('exact');
    expect(classifyDeviation(EXACT_DEVIATION_UNITS)).toBe('exact');
  });

  it('bands a small drift as close', () => {
    expect(classifyDeviation(EXACT_DEVIATION_UNITS + 0.01)).toBe('close');
    expect(classifyDeviation(CLOSE_DEVIATION_UNITS)).toBe('close');
  });

  it('bands a reading more than a quarter-unit out as uncertain', () => {
    expect(classifyDeviation(CLOSE_DEVIATION_UNITS + 0.01)).toBe('uncertain');
    expect(classifyDeviation(0.5)).toBe('uncertain');
    expect(classifyDeviation(Number.NaN)).toBe('uncertain');
  });

  it('flows through countFromWeight — half a unit out is never presented as settled', () => {
    // 10.5 g of 1 g parts is exactly ambiguous between 10 and 11.
    expect(countFromWeight({ grossGrams: 10.5, unitWeightGrams: 1 })!.confidence).toBe('uncertain');
  });
});

describe('resolveWeighCount', () => {
  const base = { unitWeightGrams: 0.5, quantity: 80, grossBlank: false };

  it('says nothing at all while the reading is still blank', () => {
    const r = resolveWeighCount({ ...base, grossGrams: Number.NaN, tareGrams: 0, grossBlank: true });
    expect(r).toEqual({ result: null, issue: null, delta: 0 });
  });

  it('resolves a good reading to a count and a signed delta', () => {
    const r = resolveWeighCount({ ...base, grossGrams: 43, tareGrams: 0 });
    expect(r.issue).toBeNull();
    expect(r.result!.count).toBe(86);
    expect(r.delta).toBe(6);
  });

  it('blames the reading — not a container the user never entered — for a negative weight', () => {
    // The ordering matters: -5 is also "less than" a zero tare, so a naive tare-too-heavy check
    // first would attach a container error to a form with no container in it.
    const r = resolveWeighCount({ ...base, grossGrams: -5, tareGrams: 0 });
    expect(r.issue).toBe('gross-negative');
    expect(r.result).toBeNull();
  });

  it('blames the container when it genuinely outweighs the reading', () => {
    const r = resolveWeighCount({ ...base, grossGrams: 5, tareGrams: 20 });
    expect(r.issue).toBe('tare-too-heavy');
  });

  it('rejects a negative container weight on its own terms', () => {
    const r = resolveWeighCount({ ...base, grossGrams: 50, tareGrams: -1 });
    expect(r.issue).toBe('tare-negative');
  });

  it('reports an unreadable entry rather than failing silently', () => {
    expect(resolveWeighCount({ ...base, grossGrams: Number.NaN, tareGrams: 0 }).issue).toBe('unreadable');
    expect(resolveWeighCount({ ...base, grossGrams: 43, tareGrams: Number.NaN }).issue).toBe('unreadable');
    // No usable per-unit weight — the division cannot be done.
    expect(resolveWeighCount({ ...base, unitWeightGrams: 0, grossGrams: 43, tareGrams: 0 }).issue).toBe(
      'unreadable',
    );
  });

  it('resolves a matching count to a zero delta with no complaint', () => {
    const r = resolveWeighCount({ ...base, grossGrams: 40, tareGrams: 0 });
    expect(r.issue).toBeNull();
    expect(r.delta).toBe(0);
  });
});

describe('weighCountNote', () => {
  const formatWeight = (grams: number) => `${grams} g`;

  it('records the reading and the signed delta', () => {
    expect(weighCountNote({ grossGrams: 43, tareGrams: 0, count: 86, delta: 6, formatWeight })).toBe(
      'Counted by weight: 43 g on scale → 86 units (+6)',
    );
  });

  it('mentions the tare only when one was used', () => {
    expect(weighCountNote({ grossGrams: 120, tareGrams: 20, count: 50, delta: -5, formatWeight })).toBe(
      'Counted by weight: 120 g on scale, tare 20 g → 50 units (-5)',
    );
  });
});
