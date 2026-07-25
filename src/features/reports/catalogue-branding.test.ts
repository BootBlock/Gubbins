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

  /**
   * `catalogueLogo` is a `liveSyncable` field in a settings backup group, so the value arrives
   * from other devices and restored backups — not only from this device's picker. A `data:image/`
   * prefix alone is not enough to be safe to put in an `<img src>`: these all carry that prefix.
   */
  it('rejects a data:image value that is not base64-encoded image bytes', () => {
    expect(normaliseCatalogueLogo('data:image/svg+xml,<svg onload=alert(1)>')).toBe('');
    expect(normaliseCatalogueLogo('data:image/png,notbase64')).toBe('');
    expect(normaliseCatalogueLogo('data:image/png;base64,')).toBe('');
    expect(normaliseCatalogueLogo('data:image/png;base64,AA"onerror="alert(1)')).toBe('');
    expect(normaliseCatalogueLogo('data:image/png;base64,AAAA\njavascript:alert(1)')).toBe('');
  });

  it('trims, so a padded value is stored in the form that was checked', () => {
    expect(normaliseCatalogueLogo('  data:image/webp;base64,AAAA  ')).toBe('data:image/webp;base64,AAAA');
  });

  it('rejects a non-string → empty', () => {
    expect(normaliseCatalogueLogo(null)).toBe('');
    expect(normaliseCatalogueLogo(undefined)).toBe('');
    expect(normaliseCatalogueLogo(42)).toBe('');
    expect(normaliseCatalogueLogo({})).toBe('');
  });
});
