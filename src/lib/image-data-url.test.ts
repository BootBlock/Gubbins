import { describe, it, expect } from 'vitest';
import { isImageDataUrl } from './image-data-url';

/**
 * The shared "safe to put in an `<img src>`" rule. Both callers (an `IMAGE` custom field's
 * value and the catalogue logo) hold values that travel via sync and restored backups, so
 * these cases are the contract that keeps a string from elsewhere becoming a URL the app
 * fetches — not incidental detail.
 */
describe('isImageDataUrl', () => {
  it('accepts what the canvas encoders produce', () => {
    // WebP is what both encoders ask the canvas for. `logoToDataUrl` uses `toDataURL`, which
    // per the HTML spec silently falls back to PNG where WebP encoding is unsupported, so that
    // shape has to pass too. (`encodeFieldImage` cannot land there — it rejects a non-WebP blob
    // outright, see `features/images/compression.ts`.)
    expect(isImageDataUrl('data:image/webp;base64,UklGRhoAAABXRUJQ')).toBe(true);
    expect(isImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('accepts any base64 image media type, not just the two the app writes', () => {
    // The predicate is a shape rule, not an allow-list of encoders — a value restored from a
    // backup written by another build must not fail merely for being JPEG.
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
    // The distinction the comment above turns on: a *trailing* newline is rejected too.
    expect(isImageDataUrl('data:image/png;base64,AAAA\n')).toBe(false);
    expect(isImageDataUrl('x data:image/png;base64,AAAA')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,AA"onerror="alert(1)')).toBe(false);
  });

  it('rejects an empty or payload-less value', () => {
    expect(isImageDataUrl('')).toBe(false);
    expect(isImageDataUrl('data:image/png;base64,')).toBe(false);
    expect(isImageDataUrl('data:image/;base64,AAAA')).toBe(false);
  });
});
