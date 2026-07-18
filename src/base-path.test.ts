import { describe, expect, it } from 'vitest';

import { DEFAULT_BASE_PATH, resolveBasePath } from './base-path';

describe('resolveBasePath', () => {
  it('defaults to the GitHub Pages project sub-path when unset', () => {
    expect(resolveBasePath(undefined)).toBe(DEFAULT_BASE_PATH);
  });

  it('treats an empty or whitespace-only value as unset', () => {
    expect(resolveBasePath('')).toBe(DEFAULT_BASE_PATH);
    expect(resolveBasePath('   ')).toBe(DEFAULT_BASE_PATH);
  });

  it('serves from the root when asked for "/"', () => {
    expect(resolveBasePath('/')).toBe('/');
    expect(resolveBasePath('///')).toBe('/');
  });

  it('adds the leading and trailing slashes Vite requires', () => {
    expect(resolveBasePath('gubbins')).toBe('/gubbins/');
    expect(resolveBasePath('/gubbins')).toBe('/gubbins/');
    expect(resolveBasePath('gubbins/')).toBe('/gubbins/');
  });

  it('leaves an already-normalised path alone, preserving case and nesting', () => {
    expect(resolveBasePath('/Gubbins/')).toBe('/Gubbins/');
    expect(resolveBasePath('/apps/Gubbins/')).toBe('/apps/Gubbins/');
  });

  it('trims surrounding whitespace before normalising', () => {
    expect(resolveBasePath('  /inventory/  ')).toBe('/inventory/');
  });
});
