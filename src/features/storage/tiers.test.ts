import { describe, it, expect } from 'vitest';
import {
  classifyStorageTier,
  isWriteSuspended,
  areNonEssentialFeaturesDisabled,
} from './tiers';

describe('storage tier classification (spec §7.6.1)', () => {
  it('classifies below 80% usage as ok', () => {
    expect(classifyStorageTier(0)).toBe('ok');
    expect(classifyStorageTier(0.5)).toBe('ok');
    expect(classifyStorageTier(0.7999)).toBe('ok');
  });

  it('classifies 80–90% as warning', () => {
    expect(classifyStorageTier(0.8)).toBe('warning');
    expect(classifyStorageTier(0.89)).toBe('warning');
  });

  it('classifies 90–95% as critical', () => {
    expect(classifyStorageTier(0.9)).toBe('critical');
    expect(classifyStorageTier(0.9499)).toBe('critical');
  });

  it('classifies 95% and above as locked', () => {
    expect(classifyStorageTier(0.95)).toBe('locked');
    expect(classifyStorageTier(1)).toBe('locked');
    expect(classifyStorageTier(1.5)).toBe('locked');
  });

  it('treats non-finite ratios as ok so missing quota data never trips a Hard Stop', () => {
    expect(classifyStorageTier(Number.NaN)).toBe('ok');
    expect(classifyStorageTier(Number.POSITIVE_INFINITY)).toBe('ok');
  });

  it('suspends writes only at the locked tier (Hard Stop)', () => {
    expect(isWriteSuspended('ok')).toBe(false);
    expect(isWriteSuspended('warning')).toBe(false);
    expect(isWriteSuspended('critical')).toBe(false);
    expect(isWriteSuspended('locked')).toBe(true);
  });

  it('disables non-essential features from the critical tier upward', () => {
    expect(areNonEssentialFeaturesDisabled('ok')).toBe(false);
    expect(areNonEssentialFeaturesDisabled('warning')).toBe(false);
    expect(areNonEssentialFeaturesDisabled('critical')).toBe(true);
    expect(areNonEssentialFeaturesDisabled('locked')).toBe(true);
  });
});
