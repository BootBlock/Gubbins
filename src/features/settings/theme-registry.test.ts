import { describe, expect, it } from 'vitest';
import {
  ACCENT_IDS,
  ACCENTS,
  ANIMATION_LEVEL_IDS,
  ANIMATION_LEVELS,
  BACKGROUND_EFFECT_IDS,
  BACKGROUND_EFFECTS,
  DEFAULT_ACCENT,
  DEFAULT_ANIMATION_LEVEL,
  DEFAULT_BACKGROUND_EFFECT,
  DEFAULT_MODE,
  MODE_OPTIONS,
  STARFIELD_VARIANTS,
  animationLevelRank,
  normaliseAccent,
  normaliseAnimationLevel,
  normaliseBackgroundEffect,
  normaliseMode,
  suppressesAmbient,
  suppressesFlourish,
  suppressesMotion,
  SURFACE_STYLES,
  SURFACE_STYLE_IDS,
  DEFAULT_SURFACE_STYLE,
  normaliseSurfaceStyle,
  DEFAULT_CUSTOM_ACCENT_HUE,
  clampAccentHue,
  customAccentVars,
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
      'sky',
      'blue',
      'indigo',
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

describe('STARFIELD_VARIANTS', () => {
  it('is the curated set of decorative mood ids, with the base cosmic look first', () => {
    expect(STARFIELD_VARIANTS).toEqual([
      'cosmic',
      'accent',
      'aurora',
      'ember',
      'mono',
      'nebula',
      'ocean',
      'sunset',
      'gold',
    ]);
  });

  it('holds no duplicate ids (the About screen picks one at random each open)', () => {
    expect(new Set(STARFIELD_VARIANTS).size).toBe(STARFIELD_VARIANTS.length);
  });
});

describe('ANIMATION_LEVELS', () => {
  it('lists the five tiers most flair → least (index === rank), each with a label + description', () => {
    expect(ANIMATION_LEVELS.map((l) => l.id)).toEqual(['headache', 'balanced', 'calm', 'minimal', 'off']);
    for (const l of ANIMATION_LEVELS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
    }
  });

  it('defaults a fresh install to the calm-but-lively `balanced` tier, and ANIMATION_LEVEL_IDS mirrors the registry', () => {
    expect(DEFAULT_ANIMATION_LEVEL).toBe('balanced');
    expect(ANIMATION_LEVEL_IDS).toEqual(ANIMATION_LEVELS.map((l) => l.id));
  });

  it('ranks levels 0..4 in listed order (headache = 0, off = 4)', () => {
    expect(ANIMATION_LEVEL_IDS.map(animationLevelRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('normaliseAnimationLevel', () => {
  it('passes every level id through unchanged', () => {
    for (const id of ANIMATION_LEVEL_IDS) expect(normaliseAnimationLevel(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the `balanced` default', () => {
    expect(normaliseAnimationLevel('sparkly')).toBe(DEFAULT_ANIMATION_LEVEL);
    // `full` was an interim id that no longer exists — it must not pass through.
    expect(normaliseAnimationLevel('full')).toBe(DEFAULT_ANIMATION_LEVEL);
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

  it('suppressesAmbient is true from Minimal onwards (a subset of motion)', () => {
    expect(ANIMATION_LEVEL_IDS.map(suppressesAmbient)).toEqual([false, false, false, true, true]);
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

describe('SURFACE_STYLES (Branding, issue #110)', () => {
  it('offers solid, soft and sheer in registry order, each with a label', () => {
    expect(SURFACE_STYLES.map((s) => s.id)).toEqual(['solid', 'soft', 'sheer']);
    for (const s of SURFACE_STYLES) expect(s.label.length).toBeGreaterThan(0);
  });

  it('defaults to solid (baseline unchanged), and SURFACE_STYLE_IDS mirrors the registry', () => {
    expect(DEFAULT_SURFACE_STYLE).toBe('solid');
    expect(SURFACE_STYLE_IDS).toEqual(SURFACE_STYLES.map((s) => s.id));
  });
});

describe('normaliseSurfaceStyle', () => {
  it('passes every surface-style id through unchanged', () => {
    for (const id of SURFACE_STYLE_IDS) expect(normaliseSurfaceStyle(id)).toBe(id);
  });

  it('coerces an unknown/stale persisted value to the solid default', () => {
    expect(normaliseSurfaceStyle('glass')).toBe(DEFAULT_SURFACE_STYLE);
    expect(normaliseSurfaceStyle('')).toBe(DEFAULT_SURFACE_STYLE);
  });
});

describe('clampAccentHue (Branding custom accent)', () => {
  it('rounds an in-range value to a whole degree', () => {
    expect(clampAccentHue(120.4)).toBe(120);
    expect(clampAccentHue(120.6)).toBe(121);
  });

  it('wraps a value past either end back into 0–359°', () => {
    expect(clampAccentHue(360)).toBe(0);
    expect(clampAccentHue(400)).toBe(40);
    expect(clampAccentHue(-10)).toBe(350);
    expect(clampAccentHue(-370)).toBe(350);
  });

  it('falls back to the default hue for a non-finite value', () => {
    expect(clampAccentHue(Number.NaN)).toBe(DEFAULT_CUSTOM_ACCENT_HUE);
    expect(clampAccentHue(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CUSTOM_ACCENT_HUE);
  });
});

describe('customAccentVars (Branding custom accent)', () => {
  it('sets ring equal to primary and highlight a step lighter, tuned per mode', () => {
    const light = customAccentVars(277, false);
    expect(light['--primary']).toBe('oklch(0.58 0.17 277)');
    expect(light['--ring']).toBe(light['--primary']);
    expect(light['--highlight']).toBe('oklch(0.64 0.17 277)');

    const dark = customAccentVars(277, true);
    expect(dark['--primary']).toBe('oklch(0.68 0.18 277)');
    expect(dark['--highlight']).toBe('oklch(0.74 0.18 277)');
  });

  it('uses dark text on the light hue band (33–245°) and near-white outside it', () => {
    // Inside the band (a yellow/green): dark foreground for legibility.
    expect(customAccentVars(120, false)['--primary-foreground']).toBe('oklch(0.2 0.03 120)');
    expect(customAccentVars(33, false)['--primary-foreground']).toBe('oklch(0.2 0.03 33)');
    expect(customAccentVars(245, false)['--primary-foreground']).toBe('oklch(0.2 0.03 245)');
    // Outside the band (a red / a violet): near-white foreground.
    expect(customAccentVars(10, false)['--primary-foreground']).toBe('oklch(0.99 0 0)');
    expect(customAccentVars(300, false)['--primary-foreground']).toBe('oklch(0.99 0 0)');
  });

  it('clamps/wraps the hue before building the tokens', () => {
    expect(customAccentVars(400, false)['--primary']).toBe('oklch(0.58 0.17 40)');
  });
});
