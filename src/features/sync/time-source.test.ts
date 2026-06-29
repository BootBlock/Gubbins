import { describe, it, expect, vi } from 'vitest';
import { parseHttpDate, httpTimeSource } from './time-source';

describe('parseHttpDate', () => {
  it('parses a standard HTTP Date header to epoch ms', () => {
    expect(parseHttpDate('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
  });

  it('returns null for a missing or unparseable header', () => {
    expect(parseHttpDate(null)).toBeNull();
    expect(parseHttpDate(undefined)).toBeNull();
    expect(parseHttpDate('not a date')).toBeNull();
  });
});

describe('httpTimeSource (§7.3 fallback)', () => {
  function fetchReturning(dateHeader: string | null): typeof fetch {
    return vi.fn(async () =>
      ({ headers: { get: (k: string) => (k.toLowerCase() === 'date' ? dateHeader : null) } }) as unknown as Response,
    ) as unknown as typeof fetch;
  }

  it('reads the Date header from a HEAD response', async () => {
    const when = 'Wed, 21 Oct 2015 07:28:00 GMT';
    const fetchImpl = fetchReturning(when);
    await expect(httpTimeSource({ url: 'https://x/', fetchImpl })).resolves.toBe(Date.parse(when));
    expect(fetchImpl).toHaveBeenCalledWith('https://x/', { method: 'HEAD', cache: 'no-store' });
  });

  it('degrades to null when the response carries no Date header', async () => {
    await expect(httpTimeSource({ url: 'https://x/', fetchImpl: fetchReturning(null) })).resolves.toBeNull();
  });

  it('degrades to null when the fetch throws (offline / CORS)', async () => {
    const fetchImpl = (vi.fn(async () => {
      throw new Error('network');
    }) as unknown) as typeof fetch;
    await expect(httpTimeSource({ url: 'https://x/', fetchImpl })).resolves.toBeNull();
  });
});
