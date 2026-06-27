import { describe, expect, it } from 'vitest';
import { bridgeReducer, initialBridgeState, type BridgeState } from './bridge-reducer';
import type { ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

const result: ScrapeResultPayload = {
  mpn: 'NE555P',
  manufacturer: 'TI',
  description: 'timer',
  distributor_url: 'https://x.test/p',
  scraped_pricing: null,
};
const error: ScrapeErrorPayload = { domain: 'x.test', error_type: 'DOM_DRIFT', reason: 'gone' };

describe('bridgeReducer (§9.3 lifecycle)', () => {
  it('starts not-ready and idle', () => {
    expect(initialBridgeState).toEqual({ ready: false, status: 'IDLE', result: null, error: null });
  });

  it('READY flips the gate and is idempotent', () => {
    const ready = bridgeReducer(initialBridgeState, { type: 'READY' });
    expect(ready.ready).toBe(true);
    expect(bridgeReducer(ready, { type: 'READY' })).toBe(ready); // same reference, no churn
  });

  it('REQUEST → RESULT yields SUCCESS with the payload', () => {
    let s: BridgeState = bridgeReducer(initialBridgeState, { type: 'READY' });
    s = bridgeReducer(s, { type: 'REQUEST' });
    expect(s.status).toBe('SCRAPING');
    s = bridgeReducer(s, { type: 'RESULT', payload: result });
    expect(s.status).toBe('SUCCESS');
    expect(s.result).toEqual(result);
  });

  it('REQUEST → ERROR yields ERROR with the payload', () => {
    let s = bridgeReducer({ ...initialBridgeState, ready: true }, { type: 'REQUEST' });
    s = bridgeReducer(s, { type: 'ERROR', payload: error });
    expect(s.status).toBe('ERROR');
    expect(s.error).toEqual(error);
  });

  it('ignores a RESULT that arrives when not scraping (stray/duplicate)', () => {
    const s = { ...initialBridgeState, ready: true, status: 'IDLE' as const };
    expect(bridgeReducer(s, { type: 'RESULT', payload: result })).toBe(s);
  });

  it('RESET returns to idle but keeps readiness', () => {
    let s = bridgeReducer({ ...initialBridgeState, ready: true }, { type: 'REQUEST' });
    s = bridgeReducer(s, { type: 'RESULT', payload: result });
    const reset = bridgeReducer(s, { type: 'RESET' });
    expect(reset.status).toBe('IDLE');
    expect(reset.result).toBeNull();
    expect(reset.ready).toBe(true);
  });
});
