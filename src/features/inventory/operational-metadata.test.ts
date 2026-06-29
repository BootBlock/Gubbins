import { describe, it, expect } from 'vitest';
import {
  coerceMetadataValue,
  buildMetadata,
  metadataToRows,
  type MetadataRow,
} from './operational-metadata';

describe('coerceMetadataValue', () => {
  it('coerces a canonical numeric string to a number', () => {
    expect(coerceMetadataValue('60')).toBe(60);
    expect(coerceMetadataValue('0.98')).toBe(0.98);
    expect(coerceMetadataValue('-45')).toBe(-45);
    expect(coerceMetadataValue(' 250 ')).toBe(250);
  });

  it('coerces true/false (case-insensitive) to booleans', () => {
    expect(coerceMetadataValue('true')).toBe(true);
    expect(coerceMetadataValue('False')).toBe(false);
  });

  it('preserves non-canonical numeric-looking strings verbatim', () => {
    // Leading zeros / trailing zeros would change the value on coercion, so keep them.
    expect(coerceMetadataValue('007')).toBe('007');
    expect(coerceMetadataValue('1.50')).toBe('1.50');
    expect(coerceMetadataValue('1e5')).toBe('1e5');
  });

  it('keeps an ordinary string (trimmed)', () => {
    expect(coerceMetadataValue('  PETG  ')).toBe('PETG');
    expect(coerceMetadataValue('')).toBe('');
  });
});

describe('buildMetadata', () => {
  it('builds a normalised record from rows, coercing values', () => {
    const rows: MetadataRow[] = [
      { key: 'bed_temp_celsius', value: '60' },
      { key: 'extrusion_multiplier', value: '0.98' },
      { key: 'material', value: 'PLA' },
      { key: 'dried', value: 'true' },
    ];
    const result = buildMetadata(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      bed_temp_celsius: 60,
      extrusion_multiplier: 0.98,
      material: 'PLA',
      dried: true,
    });
  });

  it('trims keys and ignores fully-blank rows', () => {
    const rows: MetadataRow[] = [
      { key: '  drying_time_hrs  ', value: '4' },
      { key: '', value: '' },
      { key: '   ', value: '  ' },
    ];
    const result = buildMetadata(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ drying_time_hrs: 4 });
  });

  it('returns null for an empty set of parameters', () => {
    expect(buildMetadata([])).toEqual({ ok: true, value: null });
    expect(buildMetadata([{ key: '', value: '' }])).toEqual({ ok: true, value: null });
  });

  it('rejects a value supplied without a name', () => {
    const result = buildMetadata([{ key: '', value: '60' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/name/i);
  });

  it('rejects duplicate keys (after trimming)', () => {
    const result = buildMetadata([
      { key: 'voltage', value: '3.3' },
      { key: ' voltage ', value: '5' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/duplicate/i);
  });

  it('keeps an empty-string value for a named parameter', () => {
    const result = buildMetadata([{ key: 'note', value: '' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ note: '' });
  });
});

describe('metadataToRows', () => {
  it('returns an empty list for null/undefined', () => {
    expect(metadataToRows(null)).toEqual([]);
    expect(metadataToRows(undefined)).toEqual([]);
  });

  it('stringifies primitive values for editing', () => {
    expect(
      metadataToRows({ bed_temp_celsius: 60, material: 'PLA', dried: true }),
    ).toEqual([
      { key: 'bed_temp_celsius', value: '60' },
      { key: 'material', value: 'PLA' },
      { key: 'dried', value: 'true' },
    ]);
  });

  it('JSON-stringifies a nested value rather than dropping it', () => {
    expect(metadataToRows({ profile: { layer: 0.2 } })).toEqual([
      { key: 'profile', value: '{"layer":0.2}' },
    ]);
  });

  it('round-trips a primitive record through rows and back', () => {
    const record = { bed_temp_celsius: 60, extrusion_multiplier: 0.98, dried: true };
    const result = buildMetadata(metadataToRows(record));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(record);
  });
});
