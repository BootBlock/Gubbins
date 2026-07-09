import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  normaliseTheme,
  SYSTEM_DARK_ID,
  SYSTEM_LIGHT_ID,
  THEME_BASE,
  THEME_IDS,
  THEMES,
} from './theme-registry';

describe('THEMES registry', () => {
  it('seeds the two originals plus the additive full themes, in picker order', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['dark', 'light', 'midnight', 'sepia', 'high-contrast']);
  });

  it('gives every theme a label, a tooltip, an icon and a valid base', () => {
    for (const theme of THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.tooltip.length).toBeGreaterThan(0);
      expect(theme.icon).toBeTruthy();
      expect(['light', 'dark']).toContain(theme.base);
    }
  });

  it('does not include the non-palette `system` meta-choice', () => {
    expect(THEME_IDS).not.toContain('system');
  });
});

describe('THEME_BASE', () => {
  it('maps each concrete id to its declared base', () => {
    expect(THEME_BASE.dark).toBe('dark');
    expect(THEME_BASE.light).toBe('light');
    expect(THEME_BASE.midnight).toBe('dark');
    expect(THEME_BASE.sepia).toBe('light');
    expect(THEME_BASE['high-contrast']).toBe('dark');
  });

  it('covers every registry id', () => {
    for (const id of THEME_IDS) expect(THEME_BASE[id]).toBeDefined();
  });
});

describe('system base ids + default', () => {
  it('resolves `system` to the canonical light/dark base ids', () => {
    expect(SYSTEM_LIGHT_ID).toBe('light');
    expect(SYSTEM_DARK_ID).toBe('dark');
    expect(THEME_BASE[SYSTEM_LIGHT_ID]).toBe('light');
    expect(THEME_BASE[SYSTEM_DARK_ID]).toBe('dark');
  });

  it('defaults to the app’s dark-first aesthetic', () => {
    expect(DEFAULT_THEME).toBe('dark');
  });
});

describe('normaliseTheme', () => {
  it('passes every concrete id and `system` through unchanged', () => {
    for (const id of THEME_IDS) expect(normaliseTheme(id)).toBe(id);
    expect(normaliseTheme('system')).toBe('system');
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseTheme('solarized')).toBe(DEFAULT_THEME);
    expect(normaliseTheme('')).toBe(DEFAULT_THEME);
  });
});
