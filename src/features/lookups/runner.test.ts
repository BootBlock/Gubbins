import { describe, expect, it, vi } from 'vitest';
import { isProviderUrl, LookupRunner } from './runner';
import type { LookupProvider, LookupRequest } from './types';

const provider: LookupProvider = {
  id: 'test-provider',
  hosts: ['data.example.com'],
  minIntervalMs: 1000,
  sourceName: 'Example',
  sourceUrl: 'https://data.example.com',
  outputs: [],
  canSearch: () => true,
  buildSearchRequest: () => ({ url: 'https://data.example.com/search', headers: {} }),
  parseSearchResponse: () => ({ ok: false, failure: { code: 'NO_MATCHES' } }),
  buildDetailRequest: () => null,
  parseDetailResponse: () => ({ ok: false, failure: { code: 'NOT_FOUND' } }),
};

const request: LookupRequest = { url: 'https://data.example.com/search?q=x', headers: { Accept: 'x' } };

/** A `fetch` stand-in returning one OK body, recording the calls it received. */
function okFetch(body = '{}') {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('isProviderUrl', () => {
  it('accepts only an exact declared host over https', () => {
    expect(isProviderUrl('https://data.example.com/x', ['data.example.com'])).toBe(true);
    expect(isProviderUrl('https://DATA.EXAMPLE.COM/x', ['data.example.com'])).toBe(true);
  });

  it('is not fooled by a look-alike host that merely ends in the declared one', () => {
    expect(isProviderUrl('https://data.example.com.evil.test/x', ['data.example.com'])).toBe(false);
    expect(isProviderUrl('https://notdata.example.com/x', ['data.example.com'])).toBe(false);
    // An exact match, not a suffix match — a subdomain the provider never declared is refused.
    expect(isProviderUrl('https://sub.data.example.com/x', ['data.example.com'])).toBe(false);
  });

  it('refuses a non-https scheme, a userinfo-disguised host and unparseable input', () => {
    expect(isProviderUrl('http://data.example.com/x', ['data.example.com'])).toBe(false);
    expect(isProviderUrl('https://data.example.com@evil.test/x', ['data.example.com'])).toBe(false);
    expect(isProviderUrl('not a url', ['data.example.com'])).toBe(false);
  });
});

describe('LookupRunner — the host gate', () => {
  it('never fetches a URL outside the provider’s declared hosts', async () => {
    const { impl } = okFetch();
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    const result = await runner.request(provider, { url: 'https://evil.test/x', headers: {} });
    expect(result).toEqual({ ok: false, failure: { code: 'NETWORK' } });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('LookupRunner — outcomes are values, never exceptions', () => {
  it('returns the raw body on success, and sends the provider’s headers', async () => {
    const { impl, calls } = okFetch('{"ok":1}');
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    expect(await runner.request(provider, request)).toEqual({ ok: true, value: '{"ok":1}' });
    expect(calls[0]!.init?.headers).toEqual({ Accept: 'x' });
  });

  it('reports a thrown fetch as NETWORK — a CSP block is indistinguishable from being offline', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    expect(await runner.request(provider, request)).toEqual({ ok: false, failure: { code: 'NETWORK' } });
  });

  it('reports a non-OK status with the status, so a 429 reads as a rate limit', async () => {
    const impl = vi.fn(async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    expect(await runner.request(provider, request)).toEqual({
      ok: false,
      failure: { code: 'HTTP', status: 429 },
    });
  });

  it('reports an unreadable body as UNREADABLE', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream broke');
      },
    })) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    expect(await runner.request(provider, request)).toEqual({ ok: false, failure: { code: 'UNREADABLE' } });
  });
});

describe('LookupRunner — rate limiting and serialisation', () => {
  it('does not wait before a provider’s first request', async () => {
    const { impl } = okFetch();
    const waits: number[] = [];
    const runner = new LookupRunner({
      fetchImpl: impl,
      wait: async (ms) => void waits.push(ms),
      now: () => 0,
    });
    await runner.request(provider, request);
    expect(waits).toEqual([]);
  });

  it('spaces a second request by the remaining part of minIntervalMs', async () => {
    const { impl } = okFetch();
    const waits: number[] = [];
    let clock = 0;
    const runner = new LookupRunner({
      fetchImpl: impl,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    await runner.request(provider, request);
    clock += 300; // 300ms of the 1000ms interval has already elapsed
    await runner.request(provider, request);
    expect(waits).toEqual([700]);
  });

  it('does not wait when the interval has already elapsed on its own', async () => {
    const { impl } = okFetch();
    const waits: number[] = [];
    let clock = 0;
    const runner = new LookupRunner({
      fetchImpl: impl,
      wait: async (ms) => void waits.push(ms),
      now: () => clock,
    });
    await runner.request(provider, request);
    clock += 5000;
    await runner.request(provider, request);
    expect(waits).toEqual([]);
  });

  it('serialises concurrent requests to one provider rather than firing them together', async () => {
    // Ten panels on screen must not between them hammer a host that asked them not to, so the
    // queue is what makes the interval a real limit rather than a per-call-site suggestion.
    let inFlight = 0;
    let maxInFlight = 0;
    const impl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    let clock = 0;
    const runner = new LookupRunner({
      fetchImpl: impl,
      wait: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    await Promise.all([
      runner.request(provider, request),
      runner.request(provider, request),
      runner.request(provider, request),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('does not let one failed request poison the ones queued behind it', async () => {
    let call = 0;
    const impl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return new Response('second', { status: 200 });
    }) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    const [first, second] = await Promise.all([
      runner.request(provider, request),
      runner.request(provider, request),
    ]);
    expect(first).toEqual({ ok: false, failure: { code: 'NETWORK' } });
    expect(second).toEqual({ ok: true, value: 'second' });
  });
});

describe('LookupRunner — a caller-supplied fetcher (the extension bridge)', () => {
  it('uses it instead of fetch, and still applies the gate and the spacing', async () => {
    const { impl } = okFetch();
    const waits: number[] = [];
    let clock = 0;
    const runner = new LookupRunner({
      fetchImpl: impl,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    const fetcher = vi.fn(async () => ({ ok: true as const, value: 'via extension' }));

    expect(await runner.request(provider, request, fetcher)).toEqual({ ok: true, value: 'via extension' });
    await runner.request(provider, request, fetcher);
    expect(impl).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);

    // The gate still applies, so the extension can never be handed an off-list URL either.
    expect(await runner.request(provider, { url: 'https://evil.test/x', headers: {} }, fetcher)).toEqual({
      ok: false,
      failure: { code: 'NETWORK' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('turns a rejection from the fetcher into a NETWORK failure', async () => {
    const runner = new LookupRunner({ wait: async () => {}, now: () => 0 });
    const fetcher = vi.fn(async () => {
      throw new Error('bridge died');
    });
    expect(await runner.request(provider, request, fetcher)).toEqual({
      ok: false,
      failure: { code: 'NETWORK' },
    });
  });
});
