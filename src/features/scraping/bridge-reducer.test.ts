import { describe, expect, it } from 'vitest';
import {
  bridgeReducer,
  initialBridgeState,
  pendingScrapeCount,
  type BridgeState,
} from './bridge-reducer';
import type { ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

const result: ScrapeResultPayload = {
  mpn: 'NE555P',
  manufacturer: 'TI',
  description: 'timer',
  distributor_url: 'https://x.test/p',
  scraped_pricing: null,
};
const error: ScrapeErrorPayload = { domain: 'x.test', error_type: 'DOM_DRIFT', reason: 'gone' };

const ready: BridgeState = bridgeReducer(initialBridgeState, { type: 'READY' });

describe('bridgeReducer (§9.3 lifecycle)', () => {
  it('starts not-ready with no requests', () => {
    expect(initialBridgeState).toEqual({ ready: false, requests: {} });
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
