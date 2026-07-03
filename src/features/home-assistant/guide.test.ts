import { describe, it, expect } from 'vitest';
import {
  GUIDE_STEPS,
  FIRST_STEP_ID,
  indexOfStep,
  isGuideStepId,
  nextStepId,
  prevStepId,
  progressFor,
} from './guide';

describe('guide step model', () => {
  it('has a stable, non-empty, unique ordered set of steps', () => {
    expect(GUIDE_STEPS.length).toBeGreaterThan(0);
    const ids = GUIDE_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FIRST_STEP_ID).toBe(GUIDE_STEPS[0]!.id);
  });

  it('indexOfStep locates steps and returns -1 for unknown ids', () => {
    expect(indexOfStep(FIRST_STEP_ID)).toBe(0);
    expect(indexOfStep('finish')).toBe(GUIDE_STEPS.length - 1);
    // @ts-expect-error — intentionally passing an unknown id
    expect(indexOfStep('nope')).toBe(-1);
  });

  it('isGuideStepId is a correct type guard', () => {
    expect(isGuideStepId('overview')).toBe(true);
    expect(isGuideStepId('finish')).toBe(true);
    expect(isGuideStepId('made-up')).toBe(false);
  });

  it('nextStepId walks forward and stops at the end', () => {
    expect(nextStepId('overview')).toBe('token');
    expect(nextStepId('finish')).toBeNull();
  });

  it('prevStepId walks backward and stops at the start', () => {
    expect(prevStepId('token')).toBe('overview');
    expect(prevStepId('overview')).toBeNull();
  });

  it('next/prev are inverses across every adjacent pair', () => {
    for (let i = 0; i < GUIDE_STEPS.length - 1; i++) {
      const here = GUIDE_STEPS[i]!.id;
      const there = GUIDE_STEPS[i + 1]!.id;
      expect(nextStepId(here)).toBe(there);
      expect(prevStepId(there)).toBe(here);
    }
  });

  it('progressFor is 1-based and reaches 100% on the last step', () => {
    const first = progressFor(FIRST_STEP_ID);
    expect(first.current).toBe(1);
    expect(first.total).toBe(GUIDE_STEPS.length);

    const last = progressFor('finish');
    expect(last.current).toBe(GUIDE_STEPS.length);
    expect(last.percent).toBe(100);
  });
});
