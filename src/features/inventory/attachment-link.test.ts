import { describe, it, expect } from 'vitest';
import { resolveAttachmentLink } from './attachment-link';

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
    expect(resolveAttachmentLink(localOn('dev-A'), 'dev-B').value).toBe(
      'C:\\Datasheets\\NE555.pdf',
    );
  });
});
