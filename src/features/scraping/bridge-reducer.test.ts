import { describe, expect, it } from 'vitest';
import { bridgeReducer, initialBridgeState, pendingScrapeCount, type BridgeState } from './bridge-reducer';
import type { ProductLookupResultPayload, ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

const result: ScrapeResultPayload = {
  mpn: 'NE555P',
  manufacturer: 'TI',
  description: 'timer',
  distributor_url: 'https://x.test/p',
  scraped_pricing: null,
};
const error: ScrapeErrorPayload = { domain: 'x.test', error_type: 'DOM_DRIFT', reason: 'gone' };

const product: ProductLookupResultPayload = {
  gtin: '4006381333931',
  name: 'Sticky Notes',
  brand: 'Acme',
  description: null,
  quantity: null,
};

const ready: BridgeState = bridgeReducer(initialBridgeState, { type: 'READY' });

describe('bridgeReducer (§9.3 lifecycle)', () => {
  it('starts not-ready with no requests, lookups or incoming scrapes', () => {
    expect(initialBridgeState).toEqual({ ready: false, requests: {}, lookups: {}, incoming: {} });
  });

  it('READY flips the gate and is idempotent', () => {
    expect(ready.ready).toBe(true);
    expect(bridgeReducer(ready, { type: 'READY' })).toBe(ready); // same reference, no churn
  });

  it('REQUEST → RESULT yields SUCCESS with the payload, keyed by id', () => {
    let s = bridgeReducer(ready, { type: 'REQUEST', id: 'a', url: 'https://x.test/a' });
    expect(s.requests.a?.status).toBe('SCRAPING');
    s = bridgeReducer(s, { type: 'RESULT', id: 'a', payload: result });
    expect(s.requests.a?.status).toBe('SUCCESS');
    expect(s.requests.a?.result).toEqual(result);
  });

  it('REQUEST → ERROR yields ERROR with the payload', () => {
    let s = bridgeReducer(ready, { type: 'REQUEST', id: 'a', url: 'https://x.test/a' });
    s = bridgeReducer(s, { type: 'ERROR', id: 'a', payload: error });
    expect(s.requests.a?.status).toBe('ERROR');
    expect(s.requests.a?.error).toEqual(error);
  });

  it('CLEAR removes a single finished request and keeps readiness', () => {
    let s = bridgeReducer(ready, { type: 'REQUEST', id: 'a', url: 'https://x.test/a' });
    s = bridgeReducer(s, { type: 'RESULT', id: 'a', payload: result });
    const cleared = bridgeReducer(s, { type: 'CLEAR', id: 'a' });
    expect(cleared.requests.a).toBeUndefined();
    expect(cleared.ready).toBe(true);
  });
});

describe('bridgeReducer — requestId correlation (§9 multi-scrape)', () => {
  it('ignores a RESULT for an unknown / never-requested id (stale echo)', () => {
    expect(bridgeReducer(ready, { type: 'RESULT', id: 'ghost', payload: result })).toBe(ready);
  });

  it('ignores a duplicate RESULT once a request has already settled', () => {
    let s = bridgeReducer(ready, { type: 'REQUEST', id: 'a', url: 'https://x.test/a' });
    s = bridgeReducer(s, { type: 'RESULT', id: 'a', payload: result });
    const again = bridgeReducer(s, { type: 'RESULT', id: 'a', payload: { ...result, mpn: 'OTHER' } });
    expect(again).toBe(s); // no churn, first outcome stands
  });

  it('routes concurrent scrapes independently — no cross-talk', () => {
    // Two scrapes in flight at once; results arrive out of order.
    let s = bridgeReducer(ready, { type: 'REQUEST', id: 'a', url: 'https://x.test/a' });
    s = bridgeReducer(s, { type: 'REQUEST', id: 'b', url: 'https://x.test/b' });
    expect(pendingScrapeCount(s)).toBe(2);

    s = bridgeReducer(s, { type: 'ERROR', id: 'b', payload: error });
    s = bridgeReducer(s, { type: 'RESULT', id: 'a', payload: result });

    expect(s.requests.a?.status).toBe('SUCCESS');
    expect(s.requests.a?.result).toEqual(result);
    expect(s.requests.b?.status).toBe('ERROR');
    expect(s.requests.b?.error).toEqual(error);
    expect(pendingScrapeCount(s)).toBe(0);
  });
});

describe('bridgeReducer — product lookups (recommendation point 2)', () => {
  it('LOOKUP_REQUEST → LOOKUP_RESULT resolves the tracked lookup, not the scrapes', () => {
    let s = bridgeReducer(ready, { type: 'LOOKUP_REQUEST', id: 'g', gtin: product.gtin });
    expect(s.lookups.g?.status).toBe('LOOKING_UP');
    s = bridgeReducer(s, { type: 'LOOKUP_RESULT', id: 'g', payload: product });
    expect(s.lookups.g?.status).toBe('SUCCESS');
    expect(s.lookups.g?.result).toEqual(product);
    expect(s.requests).toEqual({}); // scrapes untouched
  });

  it('LOOKUP_ERROR marshals the failure and LOOKUP_CLEAR removes it', () => {
    let s = bridgeReducer(ready, { type: 'LOOKUP_REQUEST', id: 'g', gtin: product.gtin });
    s = bridgeReducer(s, { type: 'LOOKUP_ERROR', id: 'g', payload: error });
    expect(s.lookups.g?.status).toBe('ERROR');
    const cleared = bridgeReducer(s, { type: 'LOOKUP_CLEAR', id: 'g' });
    expect(cleared.lookups.g).toBeUndefined();
  });

  it('ignores a stale/duplicate lookup outcome (identity preserved)', () => {
    expect(bridgeReducer(ready, { type: 'LOOKUP_RESULT', id: 'ghost', payload: product })).toBe(ready);
    let s = bridgeReducer(ready, { type: 'LOOKUP_REQUEST', id: 'g', gtin: product.gtin });
    s = bridgeReducer(s, { type: 'LOOKUP_RESULT', id: 'g', payload: product });
    const again = bridgeReducer(s, {
      type: 'LOOKUP_RESULT',
      id: 'g',
      payload: { ...product, name: 'Other' },
    });
    expect(again).toBe(s); // first outcome stands, no churn
  });
});

describe('bridgeReducer — incoming active-tab scrapes (Path A2)', () => {
  it('INCOMING_RESULT inserts an already-settled SUCCESS, untouching scrapes/lookups', () => {
    const s = bridgeReducer(ready, { type: 'INCOMING_RESULT', id: 'ext-1', payload: result });
    expect(s.incoming['ext-1']?.status).toBe('SUCCESS');
    expect(s.incoming['ext-1']?.result).toEqual(result);
    expect(s.requests).toEqual({});
    expect(s.lookups).toEqual({});
  });

  it('INCOMING_ERROR inserts a settled error and INCOMING_CLEAR removes it', () => {
    let s = bridgeReducer(ready, { type: 'INCOMING_ERROR', id: 'ext-1', payload: error });
    expect(s.incoming['ext-1']?.status).toBe('ERROR');
    expect(s.incoming['ext-1']?.error).toEqual(error);
    s = bridgeReducer(s, { type: 'INCOMING_CLEAR', id: 'ext-1' });
    expect(s.incoming['ext-1']).toBeUndefined();
  });

  it('ignores a re-delivered id (first payload wins, no churn — dedupe)', () => {
    const s = bridgeReducer(ready, { type: 'INCOMING_RESULT', id: 'ext-1', payload: result });
    const again = bridgeReducer(s, {
      type: 'INCOMING_RESULT',
      id: 'ext-1',
      payload: { ...result, mpn: 'OTHER' },
    });
    expect(again).toBe(s); // same reference, first delivery stands
  });

  it('INCOMING_CLEAR for an unknown id preserves identity', () => {
    expect(bridgeReducer(ready, { type: 'INCOMING_CLEAR', id: 'ghost' })).toBe(ready);
  });
});
