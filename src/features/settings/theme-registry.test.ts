import { describe, expect, it } from 'vitest';
import {
  ACCENT_IDS,
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  MODE_OPTIONS,
  normaliseAccent,
  normaliseMode,
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
      'violet',
      'blue',
      'cyan',
      'teal',
      'green',
      'lime',
      'amber',
      'orange',
      'rose',
      'pink',
      'fuchsia',
      'slate',
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
