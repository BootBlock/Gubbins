import { describe, it, expect } from 'vitest';
import { isExternalHref, resolveAttachmentLink } from './attachment-link';

const localOn = (originDeviceId: string | null) =>
  ({ kind: 'LOCAL_POINTER', value: 'C:\\Datasheets\\NE555.pdf', originDeviceId }) as const;

describe('resolveAttachmentLink', () => {
  it('treats an external URL as linked everywhere, regardless of device', () => {
    const link = resolveAttachmentLink(
      { kind: 'URL', value: 'https://ti.com/ne555.pdf', originDeviceId: null },
      'dev-A',
    );
    expect(link).toEqual({ state: 'url', value: 'https://ti.com/ne555.pdf' });
  });

  it('shows a local pointer as linked on the device that created it', () => {
    const link = resolveAttachmentLink(localOn('dev-A'), 'dev-A');
    expect(link.state).toBe('local');
    expect(link.value).toBe('C:\\Datasheets\\NE555.pdf');
  });

  it('degrades a local pointer synced from another device to "unlinked"', () => {
    const link = resolveAttachmentLink(localOn('dev-A'), 'dev-B');
    expect(link.state).toBe('unlinked');
    expect(link.value).toBe('C:\\Datasheets\\NE555.pdf');
  });

  it('treats a legacy (pre-v18) NULL-origin pointer as local — non-regressive', () => {
    // Pointers created before the origin column existed cannot be attributed, so they
    // keep the prior behaviour on whichever device shows them rather than all degrading.
    const link = resolveAttachmentLink(localOn(null), 'dev-B');
    expect(link.state).toBe('local');
  });

  it('preserves the literal path/value verbatim', () => {
    expect(resolveAttachmentLink(localOn('dev-A'), 'dev-B').value).toBe('C:\\Datasheets\\NE555.pdf');
  });
});

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
    // The gate that stops a stored string ever reaching an `href` as script — the same
    // defence `isImageDataUrl` gives the IMAGE arm. A FILE value is stored verbatim, so a
    // synced or imported row is the untrusted input this guards.
    expect(isExternalHref('javascript:alert(1)')).toBe(false);
    expect(isExternalHref('JavaScript:alert(1)')).toBe(false);
    expect(isExternalHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects free text and the empty string', () => {
    expect(isExternalHref('see the folder on the NAS')).toBe(false);
    expect(isExternalHref('')).toBe(false);
    expect(isExternalHref('   ')).toBe(false);
  });
});
