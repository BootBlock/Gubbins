import { describe, it, expect } from 'vitest';
import { isImageDataUrl } from './image-data-url';

/**
 * The shared "safe to put in an `<img src>`" rule. Both callers (an `IMAGE` custom field's
 * value and the catalogue logo) hold values that travel via sync and restored backups, so
 * these cases are the contract that keeps a string from elsewhere becoming a URL the app
 * fetches — not incidental detail.
 */
describe('isImageDataUrl', () => {
  it('accepts the canvas encoders’ output shape', () => {
    // What `encodeFieldImage` and `logoToDataUrl` actually produce (canvas → WebP, or the
    // PNG a browser without WebP encoding falls back to).
    expect(isImageDataUrl('data:image/webp;base64,UklGRhoAAABXRUJQ')).toBe(true);
    expect(isImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(true);
    expect(isImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBe(true);
  });

  it('is case-insensitive on the scheme and media type', () => {
    expect(isImageDataUrl('DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=')).toBe(true);
  });

  it('rejects a URL the app would have to fetch', () => {
    expect(isImageDataUrl('https://images.example.com/tracker.png')).toBe(false);
    expect(isImageDataUrl('//images.example.com/tracker.png')).toBe(false);
    expect(isImageDataUrl('/local/logo.png')).toBe(false);
    expect(isImageDataUrl('blob:https://example.test/abc')).toBe(false);
  });

  it('rejects a data: URL that is not a base64 image', () => {
    expect(isImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isImageDataUrl('data:text/plain,hello')).toBe(false);
    // Unencoded SVG markup — the shape that could carry angle brackets and quotes.
    expect(isImageDataUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isImageDataUrl('data:image/png,notbase64')).toBe(false);
  });

  it('rejects javascript: however it is dressed up', () => {
    expect(isImageDataUrl('javascript:alert(1)')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,AAAA;javascript:alert(1)')).toBe(false);
  });

  /**
   * The anchors carry the weight: without them a hostile suffix or a second line would pass.
   * JS `$` matches only at end of input (no `m` flag), so a trailing newline cannot smuggle
   * anything past — worth pinning, because that differs from other regex flavours.
   */
  it('anchors both ends, so nothing rides along before or after', () => {
    expect(isImageDataUrl(' data:image/png;base64,AAAA')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,AAAA ')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,AAAA\njavascript:alert(1)')).toBe(false);
    expect(isImageDataUrl('x data:image/png;base64,AAAA')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,AA"onerror="alert(1)')).toBe(false);
  });

  it('rejects an empty or payload-less value', () => {
    expect(isImageDataUrl('')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,')).toBe(false);
    expect(isImageDataUrl('data:image/;base64,AAAA')).toBe(false);
  });
});
