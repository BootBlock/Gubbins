import { describe, expect, it } from 'vitest';
import {
  ACCENT_IDS,
  ACCENTS,
  BACKGROUND_EFFECT_IDS,
  BACKGROUND_EFFECTS,
  DEFAULT_ACCENT,
  DEFAULT_BACKGROUND_EFFECT,
  DEFAULT_MODE,
  DEFAULT_STARFIELD_VARIANT,
  MODE_OPTIONS,
  STARFIELD_VARIANT_IDS,
  STARFIELD_VARIANTS,
  normaliseAccent,
  normaliseBackgroundEffect,
  normaliseMode,
  normaliseStarfieldVariant,
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

describe('BACKGROUND_EFFECTS', () => {
  it('offers none, rain and snow in registry order, each with a label', () => {
    expect(BACKGROUND_EFFECTS.map((e) => e.id)).toEqual(['none', 'rain', 'snow']);
    for (const e of BACKGROUND_EFFECTS) expect(e.label.length).toBeGreaterThan(0);
  });

  it('defaults to none (nothing painted), and BACKGROUND_EFFECT_IDS mirrors the registry', () => {
    expect(DEFAULT_BACKGROUND_EFFECT).toBe('none');
    expect(BACKGROUND_EFFECT_IDS).toEqual(BACKGROUND_EFFECTS.map((e) => e.id));
  });
});

describe('normaliseBackgroundEffect', () => {
  it('passes every effect id through unchanged', () => {
    for (const id of BACKGROUND_EFFECT_IDS) expect(normaliseBackgroundEffect(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the none default', () => {
    expect(normaliseBackgroundEffect('storm')).toBe(DEFAULT_BACKGROUND_EFFECT);
    expect(normaliseBackgroundEffect('')).toBe(DEFAULT_BACKGROUND_EFFECT);
  });
});
