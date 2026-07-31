import { describe, it, expect } from 'vitest';
import { isExternalHref } from './external-href';

/**
 * The gate deciding whether a stored custom-field value may become an `<a href>` (W1f). Its
 * inputs are untrusted by construction — a value merged from a sync peer or read out of a
 * restored backup reaches the renderer without ever meeting `validateFieldValue` — so the
 * rejections matter as much as the acceptances.
 */
describe('isExternalHref', () => {
  it('accepts http and https, the only schemes a page can navigate to', () => {
    expect(isExternalHref('https://example.com/manual.pdf')).toBe(true);
    expect(isExternalHref('http://example.test/manual.pdf')).toBe(true);
  });

  it('tolerates the surrounding whitespace a pasted address carries', () => {
    expect(isExternalHref('  https://example.com/manual.pdf  ')).toBe(true);
  });

  it('rejects a local path, a UNC share and a file:// URI — a page cannot navigate to any', () => {
    expect(isExternalHref('C:\\Datasheets\\NE555.pdf')).toBe(false);
    expect(isExternalHref('\\\\server\\share\\boiler-manual.pdf')).toBe(false);
    expect(isExternalHref('/home/user/manual.pdf')).toBe(false);
    expect(isExternalHref('file:///home/user/manual.pdf')).toBe(false);
  });

  it('rejects a scheme that would execute rather than navigate', () => {
    // The gate that stops a stored string ever reaching an `href` as script, the way
    // `isImageDataUrl` stops one reaching an `<img src>`.
    expect(isExternalHref('javascript:alert(1)')).toBe(false);
    expect(isExternalHref('JavaScript:alert(1)')).toBe(false);
    expect(isExternalHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a relative or scheme-relative reference, which is not an absolute address', () => {
    // `new URL` needs a base for these, so it throws and they are refused — which is right:
    // a custom field records where something lives, never a path inside this app.
    expect(isExternalHref('//example.com/manual.pdf')).toBe(false);
    expect(isExternalHref('/inventory')).toBe(false);
    expect(isExternalHref('./manual.pdf')).toBe(false);
  });

  it('rejects free text and the empty string', () => {
    expect(isExternalHref('see the folder on the NAS')).toBe(false);
    expect(isExternalHref('')).toBe(false);
    expect(isExternalHref('   ')).toBe(false);
  });
});
