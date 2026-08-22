import { describe, it, expect } from 'vitest';
import { isExternalHref, safeExternalHref } from './external-href';

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

/**
 * The render-site companion: "give me the href, or tell me there isn't one". Every surface that
 * turns a stored address into an anchor goes through it — supplier parts, datasheets, wishlist
 * entries and custom fields — so a value that reached the database over sync or a restore, past
 * every write-time validator, still cannot become a link.
 */
describe('safeExternalHref', () => {
  it('returns the address when it is one a page can navigate to', () => {
    expect(safeExternalHref('https://example.test/p/1')).toBe('https://example.test/p/1');
    expect(safeExternalHref('http://example.test/p/1')).toBe('http://example.test/p/1');
  });

  it('returns the TRIMMED address, so what opens is exactly what was checked', () => {
    expect(safeExternalHref('  https://example.test/p/1  ')).toBe('https://example.test/p/1');
  });

  it('returns null for an absent or blank value — simply no link', () => {
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref('   ')).toBeNull();
  });

  it('returns null for a scheme a browser would execute or cannot navigate to', () => {
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeExternalHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeExternalHref('file:///C:/datasheets/ne555.pdf')).toBeNull();
    expect(safeExternalHref('\\\\server\\share\\manual.pdf')).toBeNull();
  });
});
