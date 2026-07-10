import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEST_RECORD_KIND,
  DEFAULT_TEST_RESULT,
  TEST_RECORD_KINDS,
  TEST_RECORD_KIND_LABELS,
  TEST_RECORD_KIND_OPTIONS,
  TEST_RESULTS,
  TEST_RESULT_LABELS,
  TEST_RESULT_OPTIONS,
  TEST_RESULT_TONE,
  isTestRecordKind,
  isTestResult,
  normaliseReading,
  normaliseTestName,
  normaliseTestRecordKind,
  normaliseTestResult,
  normaliseTestText,
  planTestRecord,
  sortTestRecords,
  summariseTestRecords,
  type SummarisableTestRecord,
} from './test-records';

describe('test-records seam (feature-gap G7)', () => {
  describe('vocabularies', () => {
    it('has a label + tone for every result, and a label for every kind', () => {
      for (const result of TEST_RESULTS) {
        expect(TEST_RESULT_LABELS[result]).toBeTruthy();
        expect(TEST_RESULT_TONE[result]).toBeTruthy();
      }
      for (const kind of TEST_RECORD_KINDS) {
        expect(TEST_RECORD_KIND_LABELS[kind]).toBeTruthy();
      }
    });

    it('maps each result to a sensible tone', () => {
      expect(TEST_RESULT_TONE.PASS).toBe('positive');
      expect(TEST_RESULT_TONE.FAIL).toBe('negative');
      expect(TEST_RESULT_TONE.LIMIT).toBe('warning');
      expect(TEST_RESULT_TONE.NA).toBe('neutral');
    });

    it('exposes Select options in vocabulary order', () => {
      expect(TEST_RESULT_OPTIONS.map((o) => o.value)).toEqual([...TEST_RESULTS]);
      expect(TEST_RECORD_KIND_OPTIONS.map((o) => o.value)).toEqual([...TEST_RECORD_KINDS]);
    });
  });

  describe('type guards', () => {
    it('isTestResult accepts known results and rejects everything else', () => {
      expect(isTestResult('PASS')).toBe(true);
      expect(isTestResult('FAIL')).toBe(true);
      expect(isTestResult('pass')).toBe(false); // exact match only (guard, not normaliser)
      expect(isTestResult('MAYBE')).toBe(false);
      expect(isTestResult(null)).toBe(false);
      expect(isTestResult(3)).toBe(false);
    });

    it('isTestRecordKind accepts known kinds and rejects everything else', () => {
      expect(isTestRecordKind('CALIBRATION')).toBe(true);
      expect(isTestRecordKind('service')).toBe(false);
      expect(isTestRecordKind(undefined)).toBe(false);
    });
  });

  describe('normaliseTestResult', () => {
    it('accepts a known result verbatim', () => {
      expect(normaliseTestResult('FAIL')).toBe('FAIL');
    });
    it('is forgiving of casing + whitespace', () => {
      expect(normaliseTestResult('  fail  ')).toBe('FAIL');
      expect(normaliseTestResult('Limit')).toBe('LIMIT');
    });
    it('softens an unknown / absent value to the default', () => {
      expect(normaliseTestResult('SOMEDAY')).toBe(DEFAULT_TEST_RESULT);
      expect(normaliseTestResult(null)).toBe(DEFAULT_TEST_RESULT);
      expect(normaliseTestResult(undefined)).toBe(DEFAULT_TEST_RESULT);
      expect(normaliseTestResult('')).toBe(DEFAULT_TEST_RESULT);
    });
  });

  describe('normaliseTestRecordKind', () => {
    it('accepts, forgives casing, and softens unknowns', () => {
      expect(normaliseTestRecordKind('SERVICE')).toBe('SERVICE');
      expect(normaliseTestRecordKind(' calibration ')).toBe('CALIBRATION');
      expect(normaliseTestRecordKind('AUDIT')).toBe(DEFAULT_TEST_RECORD_KIND);
      expect(normaliseTestRecordKind(null)).toBe(DEFAULT_TEST_RECORD_KIND);
    });
  });

  describe('normaliseTestName / normaliseTestText', () => {
    it('trims a name and rejects blanks', () => {
      expect(normaliseTestName('  Insulation  ')).toBe('Insulation');
      expect(normaliseTestName('   ')).toBeNull();
      expect(normaliseTestName(null)).toBeNull();
    });
    it('trims optional text to null when blank', () => {
      expect(normaliseTestText('  MΩ ')).toBe('MΩ');
      expect(normaliseTestText('')).toBeNull();
      expect(normaliseTestText(undefined)).toBeNull();
    });
  });

  describe('normaliseReading', () => {
    it('returns null when absent', () => {
      expect(normaliseReading(null)).toBeNull();
      expect(normaliseReading(undefined)).toBeNull();
    });
    it('accepts finite numbers, including negatives and zero', () => {
      expect(normaliseReading(12.5)).toBe(12.5);
      expect(normaliseReading(0)).toBe(0);
      expect(normaliseReading(-40)).toBe(-40);
    });
    it('flags a non-finite supplied value as undefined', () => {
      expect(normaliseReading(Number.NaN)).toBeUndefined();
      expect(normaliseReading(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
  });

  describe('planTestRecord', () => {
    it('rejects a blank name', () => {
      expect(planTestRecord({ name: '  ' })).toEqual({ ok: false, reason: 'EMPTY_NAME' });
    });

    it('rejects a non-finite reading with a specific reason', () => {
      expect(planTestRecord({ name: 'Insulation', reading: Number.NaN })).toEqual({
        ok: false,
        reason: 'INVALID_READING',
      });
    });

    it('normalises a full record, trimming and softening vocabularies', () => {
      const plan = planTestRecord({
        kind: ' calibration ',
        name: '  Annual calibration ',
        result: 'limit',
        reading: 0.4,
        unit: ' % ',
        note: '  drift within tolerance ',
      });
      expect(plan).toEqual({
        ok: true,
        record: {
          kind: 'CALIBRATION',
          name: 'Annual calibration',
          result: 'LIMIT',
          reading: 0.4,
          unit: '%',
          note: 'drift within tolerance',
        },
      });
    });

    it('applies defaults for an omitted kind/result and blank optionals', () => {
      const plan = planTestRecord({ name: 'Quick check' });
      expect(plan).toEqual({
        ok: true,
        record: {
          kind: DEFAULT_TEST_RECORD_KIND,
          name: 'Quick check',
          result: DEFAULT_TEST_RESULT,
          reading: null,
          unit: null,
          note: null,
        },
      });
    });

    it('drops a unit when there is no reading (a unit needs a measurement)', () => {
      const plan = planTestRecord({ name: 'Visual', unit: 'MΩ' });
      expect(plan.ok && plan.record.unit).toBeNull();
    });

    it('keeps a unit when a reading is present, including a zero reading', () => {
      const plan = planTestRecord({ name: 'Offset', reading: 0, unit: 'V' });
      expect(plan.ok && plan.record).toMatchObject({ reading: 0, unit: 'V' });
    });
  });

  describe('sortTestRecords', () => {
    it('orders newest performedAt first, then newest createdAt, then id', () => {
      const rows = [
        { id: 'c', performedAt: 100, createdAt: 5 },
        { id: 'a', performedAt: 200, createdAt: 1 },
        { id: 'b', performedAt: 200, createdAt: 9 },
        { id: 'z', performedAt: 100, createdAt: 5 },
      ];
      expect(sortTestRecords(rows).map((r) => r.id)).toEqual(['b', 'a', 'c', 'z']);
    });

    it('does not mutate its input', () => {
      const rows = [
        { id: 'a', performedAt: 1, createdAt: 1 },
        { id: 'b', performedAt: 2, createdAt: 2 },
      ];
      const before = [...rows];
      sortTestRecords(rows);
      expect(rows).toEqual(before);
    });
  });

  describe('summariseTestRecords', () => {
    const rec = (over: Partial<SummarisableTestRecord>): SummarisableTestRecord => ({
      id: 'r',
      performedAt: 0,
      createdAt: 0,
      result: 'PASS',
      kind: 'TEST',
      ...over,
    });

    it('is empty for no records', () => {
      const s = summariseTestRecords([]);
      expect(s.count).toBe(0);
      expect(s.failCount).toBe(0);
      expect(s.latestResult).toBeNull();
      expect(s.byResult).toEqual({ PASS: 0, FAIL: 0, LIMIT: 0, NA: 0 });
      expect(s.byKind).toEqual({ TEST: 0, CALIBRATION: 0, SERVICE: 0 });
    });

    it('tallies results and kinds and counts failures', () => {
      const s = summariseTestRecords([
        rec({ id: 'a', result: 'PASS', kind: 'TEST', performedAt: 1 }),
        rec({ id: 'b', result: 'FAIL', kind: 'CALIBRATION', performedAt: 2 }),
        rec({ id: 'c', result: 'FAIL', kind: 'SERVICE', performedAt: 3 }),
        rec({ id: 'd', result: 'LIMIT', kind: 'TEST', performedAt: 4 }),
      ]);
      expect(s.count).toBe(4);
      expect(s.byResult).toEqual({ PASS: 1, FAIL: 2, LIMIT: 1, NA: 0 });
      expect(s.byKind).toEqual({ TEST: 2, CALIBRATION: 1, SERVICE: 1 });
      expect(s.failCount).toBe(2);
    });

    it('reports the most-recent record’s result (deterministic on ties)', () => {
      const s = summariseTestRecords([
        rec({ id: 'old', result: 'PASS', performedAt: 100, createdAt: 1 }),
        rec({ id: 'new', result: 'FAIL', performedAt: 300, createdAt: 1 }),
        rec({ id: 'mid', result: 'LIMIT', performedAt: 200, createdAt: 1 }),
      ]);
      expect(s.latestResult).toBe('FAIL');
    });
  });
});
