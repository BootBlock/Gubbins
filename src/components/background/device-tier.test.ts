import { describe, expect, it } from 'vitest';
import { DEFAULT_DPR_CAP, REDUCED_DPR_CAP, precipDprCap } from './device-tier';

describe('precipDprCap', () => {
  it('leaves a device the hints say nothing about at the engine default', () => {
    expect(precipDprCap({})).toBe(DEFAULT_DPR_CAP);
  });

  it('leaves a capable desktop at the engine default', () => {
    expect(precipDprCap({ cores: 16, memory: 8, saveData: false, coarsePointer: false })).toBe(
      DEFAULT_DPR_CAP,
    );
  });

  it.each([
    ['few cores', { cores: 4 }],
    ['little memory', { memory: 4 }],
    ['an explicit save-data request', { saveData: true }],
    ['a touch pointer', { coarsePointer: true }],
  ])('trims the cap on %s alone', (_label, hints) => {
    expect(precipDprCap(hints)).toBe(REDUCED_DPR_CAP);
  });

  it('trims a phone that reports plenty of cores and memory, on the pointer alone', () => {
    // The signals are deliberately OR-ed, not scored: an 8-core phone is still a phone.
    expect(precipDprCap({ cores: 8, memory: 8, coarsePointer: true })).toBe(REDUCED_DPR_CAP);
  });

  it('does not trim just above each threshold', () => {
    expect(precipDprCap({ cores: 5 })).toBe(DEFAULT_DPR_CAP);
    expect(precipDprCap({ memory: 8 })).toBe(DEFAULT_DPR_CAP);
  });
});
