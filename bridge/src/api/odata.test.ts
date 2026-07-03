/**
 * Unit tests for the OData option layer: `$orderby` validation and the alias reader.
 */
import { describe, expect, it } from 'vitest';
import { BadQueryError, parseOrderBy, readOption } from './odata.ts';

describe('parseOrderBy', () => {
  it('parses fields with explicit and defaulted directions', () => {
    expect(parseOrderBy('quantity desc, name')).toEqual([
      { field: 'quantity', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('is case-insensitive on the direction', () => {
    expect(parseOrderBy('name DESC')).toEqual([{ field: 'name', direction: 'desc' }]);
  });

  it('rejects an unknown field, a bad direction, and a malformed term', () => {
    expect(() => parseOrderBy('bogus')).toThrow(/Sortable fields/);
    expect(() => parseOrderBy('name sideways')).toThrow(/asc.*desc|direction/);
    expect(() => parseOrderBy('name asc desc')).toThrow(/Malformed/);
    expect(() => parseOrderBy('')).toThrow(BadQueryError);
  });
});

describe('readOption', () => {
  it('prefers the OData $name over the canonical name', () => {
    const url = new URL('http://x/?$top=5&limit=9');
    expect(readOption(url, '$top', 'limit')).toBe('5');
  });
  it('falls back to the canonical name', () => {
    const url = new URL('http://x/?limit=9');
    expect(readOption(url, '$top', 'limit')).toBe('9');
  });
  it('returns null when neither is present', () => {
    expect(readOption(new URL('http://x/'), '$top', 'limit')).toBeNull();
  });
});
