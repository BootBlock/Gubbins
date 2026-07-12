import { describe, expect, it, vi } from 'vitest';
import { lookupProductOnline } from './product-lookup-online';

/** A minimal `fetch` stub returning a text body + ok/status. */
function fakeFetch(body: string, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  const ok = init.ok ?? true;
  return vi.fn().mockResolvedValue({
    ok,
    status: init.status ?? (ok ? 200 : 500),
    text: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('lookupProductOnline (issue #59)', () => {
  it('resolves a found product from the Open Food Facts body', async () => {
    const body = JSON.stringify({
      status: 1,
      product: { code: '4006381333931', product_name: 'Test Pen', brands: 'Acme, Acme Co' },
    });
    const result = await lookupProductOnline('4006381333931', fakeFetch(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.name).toBe('Test Pen');
      expect(result.payload.brand).toBe('Acme');
    }
  });

  it('reports a clean not-found for an unknown barcode', async () => {
    const result = await lookupProductOnline('0000000000000', fakeFetch(JSON.stringify({ status: 0 })));
    expect(result.ok).toBe(false);
  });

  it('fails soft on a network error rather than throwing', async () => {
    const throwing = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const result = await lookupProductOnline('4006381333931', throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reach the product database/i);
  });

  it('fails soft on a non-OK HTTP status', async () => {
    const result = await lookupProductOnline('4006381333931', fakeFetch('', { ok: false, status: 503 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/503/);
  });

  it('requests the barcode-scoped Open Food Facts URL', async () => {
    const spy = fakeFetch(JSON.stringify({ status: 0 }));
    await lookupProductOnline('4006381333931', spy);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('/product/4006381333931.json'),
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });
});
