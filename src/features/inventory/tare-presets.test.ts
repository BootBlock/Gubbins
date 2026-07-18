import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TARE_PRESETS,
  TARE_PRESET_KINDS,
  gaugeTareWeightUnit,
  groupTarePresetsByKind,
  normaliseTareGrams,
  normaliseTarePresetKind,
  normaliseTarePresetName,
  planTarePreset,
  searchTarePresets,
  tarePresetLabel,
  tareFieldValue,
  type TarePreset,
} from './tare-presets';

const preset = (over: Partial<TarePreset> = {}): TarePreset => ({
  id: 'p1',
  name: 'Test spool',
  kind: 'SPOOL',
  tareGrams: 200,
  ...over,
});

describe('the built-in catalogue', () => {
  it('gives every entry a unique id', () => {
    const ids = BUILT_IN_TARE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('files every entry under a known kind', () => {
    for (const p of BUILT_IN_TARE_PRESETS) {
      expect(TARE_PRESET_KINDS).toContain(p.kind);
    }
  });

  /**
   * The catalogue is reference data about real products, so a nonsensical weight is a data
   * error rather than a rendering one. The ceiling is deliberately generous (a 2 kg spool
   * exists) but still rules out a unit mix-up — a figure entered in kilograms by mistake.
   */
  it('carries a physically plausible weight for every entry', () => {
    for (const p of BUILT_IN_TARE_PRESETS) {
      expect(p.tareGrams).toBeGreaterThan(0);
      expect(p.tareGrams).toBeLessThan(2000);
    }
  });

  it('marks nothing in the catalogue as user-saved', () => {
    expect(BUILT_IN_TARE_PRESETS.every((p) => !p.saved)).toBe(true);
  });
});

describe('searchTarePresets', () => {
  const presets = [
    preset({ id: 'a', name: 'PolyTerra PLA 1 kg (cardboard)', brand: 'Polymaker' }),
    preset({ id: 'b', name: '1 kg spool (plastic)', brand: 'eSUN' }),
    preset({ id: 'c', name: 'Flour jar', kind: 'JAR' }),
  ];

  it('returns everything for a blank query', () => {
    expect(searchTarePresets(presets, '   ')).toEqual(presets);
  });

  it('matches on the brand as well as the name', () => {
    expect(searchTarePresets(presets, 'polymaker').map((p) => p.id)).toEqual(['a']);
  });

  it('requires every term to match, across name and brand together', () => {
    expect(searchTarePresets(presets, 'polymaker cardboard').map((p) => p.id)).toEqual(['a']);
    expect(searchTarePresets(presets, 'polymaker plastic')).toEqual([]);
  });

  it('matches on the kind, so "jar" narrows to jars', () => {
    expect(searchTarePresets(presets, 'jar').map((p) => p.id)).toEqual(['c']);
  });

  /**
   * Notes routinely mention a *contrasting* material ("plastic sides plus the cardboard centre
   * ring"), so searching them would surface a plastic spool under a "cardboard" filter — the
   * opposite of what the user asked for.
   */
  it('does not match on the note', () => {
    const withNote = [preset({ id: 'x', name: 'Plastic spool', note: 'has a cardboard core' })];
    expect(searchTarePresets(withNote, 'cardboard')).toEqual([]);
  });

  it('keeps the real catalogue honest: "cardboard" returns only cardboard spools', () => {
    for (const match of searchTarePresets(BUILT_IN_TARE_PRESETS, 'cardboard')) {
      expect(match.name.toLowerCase()).toContain('cardboard');
    }
  });
});

describe('tareFieldValue', () => {
  it('renders grams unchanged in grams', () => {
    expect(tareFieldValue(250, 'g')).toBe('250');
  });

  it('converts into the field unit', () => {
    expect(tareFieldValue(1000, 'kg')).toBe('1');
  });

  /** Without the rounding, 250 g → oz fills the box with floating-point noise. */
  it('rounds to four decimals rather than leaking float noise', () => {
    expect(tareFieldValue(250, 'oz')).toBe('8.8185');
  });
});

describe('groupTarePresetsByKind', () => {
  it('groups in kind order and drops empty kinds', () => {
    const groups = groupTarePresetsByKind([
      preset({ id: 'a', kind: 'JAR' }),
      preset({ id: 'b', kind: 'SPOOL' }),
      preset({ id: 'c', kind: 'JAR' }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['SPOOL', 'JAR']);
    expect(groups[1].presets.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('tarePresetLabel', () => {
  it('reads brand and name as one phrase', () => {
    expect(tarePresetLabel(preset({ brand: 'eSUN', name: '1 kg spool' }))).toBe('eSUN 1 kg spool');
  });

  it('drops the brand when there is none', () => {
    expect(tarePresetLabel(preset({ name: 'Flour jar' }))).toBe('Flour jar');
  });
});

describe('gaugeTareWeightUnit', () => {
  it('recognises the mass units, case- and space-insensitively', () => {
    expect(gaugeTareWeightUnit('g')).toBe('g');
    expect(gaugeTareWeightUnit(' Kg ')).toBe('kg');
    expect(gaugeTareWeightUnit('LB')).toBe('lb');
  });

  /**
   * The load-bearing case: a gauge measured in metres or millilitres has a tare in *those*
   * units, so a gram preset must not be offered — writing one in would be a meaningless
   * number that merely looks plausible.
   */
  it('returns null for a gauge that is not measured by mass', () => {
    expect(gaugeTareWeightUnit('m')).toBeNull();
    expect(gaugeTareWeightUnit('ml')).toBeNull();
    expect(gaugeTareWeightUnit('sheets')).toBeNull();
    expect(gaugeTareWeightUnit('')).toBeNull();
    expect(gaugeTareWeightUnit(null)).toBeNull();
  });
});

describe('normalisers', () => {
  it('trims a name and treats blank as absent', () => {
    expect(normaliseTarePresetName('  Flour jar ')).toBe('Flour jar');
    expect(normaliseTarePresetName('   ')).toBeNull();
    expect(normaliseTarePresetName(undefined)).toBeNull();
  });

  it('softens an unknown kind to OTHER', () => {
    expect(normaliseTarePresetKind('SPOOL')).toBe('SPOOL');
    expect(normaliseTarePresetKind('FROM_A_NEWER_BUILD')).toBe('OTHER');
    expect(normaliseTarePresetKind(null)).toBe('OTHER');
  });

  /** `undefined` means rejected; a stored zero is legitimate and must survive. */
  it('accepts zero but rejects negative and non-finite weights', () => {
    expect(normaliseTareGrams(0)).toBe(0);
    expect(normaliseTareGrams(250)).toBe(250);
    expect(normaliseTareGrams(-1)).toBeUndefined();
    expect(normaliseTareGrams(Number.NaN)).toBeUndefined();
    expect(normaliseTareGrams(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normaliseTareGrams(null)).toBeUndefined();
  });
});

describe('planTarePreset', () => {
  it('normalises a valid entry', () => {
    const plan = planTarePreset({
      name: '  Flour jar ',
      brand: '  ',
      kind: 'JAR',
      tareGrams: 412,
      note: ' weighed empty ',
    });
    expect(plan).toEqual({
      ok: true,
      preset: { name: 'Flour jar', brand: null, kind: 'JAR', tareGrams: 412, note: 'weighed empty' },
    });
  });

  it('blames the name when it is blank', () => {
    expect(planTarePreset({ name: '   ', tareGrams: 100 })).toEqual({
      ok: false,
      reason: 'EMPTY_NAME',
    });
  });

  it('blames the weight when it cannot be stored', () => {
    expect(planTarePreset({ name: 'Jar', tareGrams: -5 })).toEqual({
      ok: false,
      reason: 'INVALID_TARE',
    });
  });

  /** The name is checked first, so a doubly-invalid entry reports the field read first. */
  it('reports the name before the weight when both are wrong', () => {
    expect(planTarePreset({ name: '', tareGrams: -5 })).toEqual({
      ok: false,
      reason: 'EMPTY_NAME',
    });
  });
});
