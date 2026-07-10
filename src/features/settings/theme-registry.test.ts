import { describe, expect, it } from 'vitest';
import {
  ACCENT_IDS,
  ACCENTS,
  ANIMATION_LEVEL_IDS,
  ANIMATION_LEVELS,
  DEFAULT_ACCENT,
  DEFAULT_ANIMATION_LEVEL,
  DEFAULT_MODE,
  DEFAULT_STARFIELD_VARIANT,
  MODE_OPTIONS,
  STARFIELD_VARIANT_IDS,
  STARFIELD_VARIANTS,
  animationLevelRank,
  normaliseAccent,
  normaliseAnimationLevel,
  normaliseMode,
  normaliseStarfieldVariant,
  suppressesFlourish,
  suppressesMotion,
} from './theme-registry';

describe('MODE_OPTIONS', () => {
  it('offers Light, Dark and System, each with a label', () => {
    expect(MODE_OPTIONS.map((o) => o.value)).toEqual(['light', 'dark', 'system']);
    for (const o of MODE_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });

  it('defaults to the app’s dark-first aesthetic', () => {
    expect(DEFAULT_MODE).toBe('dark');
  });
});

describe('normaliseMode', () => {
  it('passes every offered mode through unchanged', () => {
    for (const { value } of MODE_OPTIONS) expect(normaliseMode(value)).toBe(value);
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseMode('midnight')).toBe(DEFAULT_MODE);
    expect(normaliseMode('')).toBe(DEFAULT_MODE);
  });
});

describe('ACCENTS', () => {
  it('seeds the accent colours in picker order, each with a label', () => {
    expect(ACCENTS.map((a) => a.id)).toEqual([
      'rose',
      'orange',
      'amber',
      'yellow',
      'lime',
      'green',
      'emerald',
      'teal',
      'cyan',
      'blue',
      'violet',
      'purple',
      'fuchsia',
      'pink',
    ]);
    for (const a of ACCENTS) expect(a.label.length).toBeGreaterThan(0);
  });

  it('defaults to the signature violet, and ACCENT_IDS mirrors the registry', () => {
    expect(DEFAULT_ACCENT).toBe('violet');
    expect(ACCENT_IDS).toEqual(ACCENTS.map((a) => a.id));
  });
});

describe('normaliseAccent', () => {
  it('passes every accent id through unchanged', () => {
    for (const id of ACCENT_IDS) expect(normaliseAccent(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseAccent('turquoise')).toBe(DEFAULT_ACCENT);
    expect(normaliseAccent('')).toBe(DEFAULT_ACCENT);
  });
});

describe('STARFIELD_VARIANTS (visual-flair F11)', () => {
  it('offers the curated variant set in registry order, each with a label', () => {
    expect(STARFIELD_VARIANTS.map((v) => v.id)).toEqual(['cosmic', 'accent', 'aurora', 'ember', 'mono']);
    for (const v of STARFIELD_VARIANTS) expect(v.label.length).toBeGreaterThan(0);
  });

  it('defaults to the shipped cosmic look, and STARFIELD_VARIANT_IDS mirrors the registry', () => {
    expect(DEFAULT_STARFIELD_VARIANT).toBe('cosmic');
    expect(STARFIELD_VARIANT_IDS).toEqual(STARFIELD_VARIANTS.map((v) => v.id));
  });
});

describe('normaliseStarfieldVariant', () => {
  it('passes every variant id through unchanged', () => {
    for (const id of STARFIELD_VARIANT_IDS) expect(normaliseStarfieldVariant(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the cosmic default', () => {
    expect(normaliseStarfieldVariant('nebula')).toBe(DEFAULT_STARFIELD_VARIANT);
    expect(normaliseStarfieldVariant('')).toBe(DEFAULT_STARFIELD_VARIANT);
  });
});

describe('ANIMATION_LEVELS', () => {
  it('lists the five tiers liveliest → calmest (index === rank), each with a label + description', () => {
    expect(ANIMATION_LEVELS.map((l) => l.id)).toEqual(['full', 'balanced', 'calm', 'off', 'headache']);
    for (const l of ANIMATION_LEVELS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
    }
  });

  it('defaults to the liveliest `full`, and ANIMATION_LEVEL_IDS mirrors the registry', () => {
    expect(DEFAULT_ANIMATION_LEVEL).toBe('full');
    expect(ANIMATION_LEVEL_IDS).toEqual(ANIMATION_LEVELS.map((l) => l.id));
  });

  it('ranks levels 0..4 in listed order', () => {
    expect(ANIMATION_LEVEL_IDS.map(animationLevelRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('normaliseAnimationLevel', () => {
  it('passes every level id through unchanged', () => {
    for (const id of ANIMATION_LEVEL_IDS) expect(normaliseAnimationLevel(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the `full` default', () => {
    expect(normaliseAnimationLevel('sparkly')).toBe(DEFAULT_ANIMATION_LEVEL);
    expect(normaliseAnimationLevel('')).toBe(DEFAULT_ANIMATION_LEVEL);
  });
});

describe('animation-level thresholds', () => {
  it('suppressesFlourish is true from Balanced onwards (a superset of motion)', () => {
    expect(ANIMATION_LEVEL_IDS.map(suppressesFlourish)).toEqual([false, true, true, true, true]);
  });

  it('suppressesMotion is true from Calm onwards', () => {
    expect(ANIMATION_LEVEL_IDS.map(suppressesMotion)).toEqual([false, false, true, true, true]);
  });

  it('every motion-suppressed level also suppresses flourishes (flourish ⊇ motion)', () => {
    for (const id of ANIMATION_LEVEL_IDS) {
      if (suppressesMotion(id)) expect(suppressesFlourish(id)).toBe(true);
    }
  });
});
