import { describe, it, expect } from 'vitest';
import { normaliseCatalogueLogo } from './catalogue-branding';

describe('normaliseCatalogueLogo', () => {
  it('keeps a data:image URL', () => {
    const url = 'data:image/webp;base64,AAAA';
    expect(normaliseCatalogueLogo(url)).toBe(url);
    expect(normaliseCatalogueLogo('data:image/png;base64,BBBB')).toBe('data:image/png;base64,BBBB');
  });

  it('rejects a non-image or non-data string → empty', () => {
    expect(normaliseCatalogueLogo('https://example.test/logo.png')).toBe('');
    expect(normaliseCatalogueLogo('data:text/html,<script>')).toBe('');
    expect(normaliseCatalogueLogo('')).toBe('');
  });

  it('rejects a non-string → empty', () => {
    expect(normaliseCatalogueLogo(null)).toBe('');
    expect(normaliseCatalogueLogo(undefined)).toBe('');
    expect(normaliseCatalogueLogo(42)).toBe('');
    expect(normaliseCatalogueLogo({})).toBe('');
  });
});
