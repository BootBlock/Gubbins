import { describe, it, expect } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { Fullness, VolumetricFullness } from '../location-fullness';
import { describeVolumetricFullness } from './volumetric-fullness-text';

const fmt = makeFormatters(); // en-GB, volumeUnit 'auto'

/** Build a volumetric fullness reading for the caption. */
function vf(over: Partial<VolumetricFullness> = {}): VolumetricFullness {
  return {
    percent: 0,
    full: false,
    over: false,
    usedVolume: 0,
    capacityVolume: 30_000_000, // 30 L
    coverage: 1,
    measuredItems: 1,
    totalItems: 1,
    ...over,
  };
}

describe('describeVolumetricFullness', () => {
  it('returns null for count-mode fullness (no volume figures to caption)', () => {
    const countMode: Fullness = { percent: 50, full: false, over: false };
    expect(describeVolumetricFullness(countMode, fmt)).toBeNull();
  });

  it('shows used and capacity in one unit when the used amount is legible there', () => {
    expect(describeVolumetricFullness(vf({ usedVolume: 12_500_000 }), fmt)).toBe('12.5 L of 30 L');
  });

  it('reads an empty measured location honestly as "0 L of 30 L"', () => {
    expect(describeVolumetricFullness(vf({ usedVolume: 0 }), fmt)).toBe('0 L of 30 L');
  });

  it('never renders a non-zero used volume as "0 L" — it falls back to a smaller unit', () => {
    // 4,000 mm³ = 4 cm³ = 0.004 L → would round to "0 L" in the capacity unit; show "4 cm³".
    const text = describeVolumetricFullness(vf({ usedVolume: 4_000 }), fmt);
    expect(text).toBe('4 cm³ of 30 L');
    expect(text).not.toContain('0 L of');
  });

  it('appends the coverage caption only when coverage is incomplete', () => {
    expect(describeVolumetricFullness(vf({ usedVolume: 12_500_000, coverage: 1 }), fmt)).not.toContain(
      'measured',
    );
    expect(
      describeVolumetricFullness(
        vf({ usedVolume: 12_500_000, coverage: 0.5, measuredItems: 1, totalItems: 2 }),
        fmt,
      ),
    ).toBe('12.5 L of 30 L · based on 1 of 2 items measured');
  });
});
