import { describe, expect, it } from 'vitest';
import {
  planPriceRefresh,
  summarisePriceRefresh,
  type RefreshCandidate,
  type RefreshOutcome,
} from './price-refresh';

const DIGIKEY = 'https://www.digikey.com/en/products/detail/x/y/123';
const MOUSER = 'https://www.mouser.com/ProductDetail/abc';
const AMAZON = 'https://www.amazon.co.uk/dp/B0TEST0001';

function candidate(over: Partial<RefreshCandidate> = {}): RefreshCandidate {
  return { id: 'p1', supplierName: 'DigiKey', url: DIGIKEY, ...over };
}

describe('planPriceRefresh', () => {
  it('includes a supplier whose URL is a supported distributor', () => {
    const plan = planPriceRefresh([candidate()]);
    expect(plan.fetchable).toEqual([{ id: 'p1', supplierName: 'DigiKey', url: DIGIKEY }]);
    expect(plan.skipped).toHaveLength(0);
  });

  it('skips a supplier with no URL', () => {
    const plan = planPriceRefresh([candidate({ url: null })]);
    expect(plan.fetchable).toHaveLength(0);
    expect(plan.skipped).toEqual([{ id: 'p1', supplierName: 'DigiKey', reason: 'NO_URL' }]);
  });

  it('treats a whitespace-only URL as no URL', () => {
    const plan = planPriceRefresh([candidate({ url: '   ' })]);
    expect(plan.skipped[0]?.reason).toBe('NO_URL');
  });

  it('skips a URL on an unsupported (non-background-fetchable) domain such as Amazon', () => {
    const plan = planPriceRefresh([candidate({ supplierName: 'Amazon', url: AMAZON })]);
    expect(plan.fetchable).toHaveLength(0);
    expect(plan.skipped).toEqual([{ id: 'p1', supplierName: 'Amazon', reason: 'UNSUPPORTED_URL' }]);
  });

  it('partitions a mixed set in order', () => {
    const plan = planPriceRefresh([
      candidate({ id: 'a', supplierName: 'DigiKey', url: DIGIKEY }),
      candidate({ id: 'b', supplierName: 'Mouser', url: MOUSER }),
      candidate({ id: 'c', supplierName: 'Amazon', url: AMAZON }),
      candidate({ id: 'd', supplierName: 'Local shop', url: null }),
    ]);
    expect(plan.fetchable.map((f) => f.id)).toEqual(['a', 'b']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['UNSUPPORTED_URL', 'NO_URL']);
  });
});

function priced(over: Partial<Extract<RefreshOutcome, { kind: 'PRICE' }>> = {}): RefreshOutcome {
  return { kind: 'PRICE', id: 'a', supplierName: 'DigiKey', value: 0.5, currency: 'GBP', ...over };
}

describe('summarisePriceRefresh', () => {
  it('names the cheapest price when all share one currency', () => {
    const summary = summarisePriceRefresh([
      priced({ id: 'a', supplierName: 'DigiKey', value: 0.48 }),
      priced({ id: 'b', supplierName: 'Mouser', value: 0.42 }),
      priced({ id: 'c', supplierName: 'RS', value: 0.51 }),
    ]);
    expect(summary.priceCount).toBe(3);
    expect(summary.cheapest).toMatchObject({ supplierName: 'Mouser', value: 0.42 });
    expect(summary.mixedCurrencies).toBe(false);
  });

  it('resolves a tie to the first-requested supplier (deterministic)', () => {
    const summary = summarisePriceRefresh([
      priced({ id: 'a', supplierName: 'DigiKey', value: 0.42 }),
      priced({ id: 'b', supplierName: 'Mouser', value: 0.42 }),
    ]);
    expect(summary.cheapest?.supplierName).toBe('DigiKey');
  });

  it('does not claim a cheapest across mixed currencies', () => {
    const summary = summarisePriceRefresh([
      priced({ id: 'a', supplierName: 'DigiKey', value: 0.48, currency: 'GBP' }),
      priced({ id: 'b', supplierName: 'Mouser', value: 0.42, currency: 'USD' }),
    ]);
    expect(summary.mixedCurrencies).toBe(true);
    expect(summary.cheapest).toBeNull();
    expect(summary.prices).toHaveLength(2);
  });

  it('reports a single fetched price (pinned price-source refresh) as the cheapest', () => {
    const summary = summarisePriceRefresh([priced({ id: 'a', supplierName: 'Mouser', value: 0.42 })]);
    expect(summary.priceCount).toBe(1);
    expect(summary.cheapest).toMatchObject({ supplierName: 'Mouser', value: 0.42 });
  });

  it('counts no-price and error outcomes without treating them as prices', () => {
    const summary = summarisePriceRefresh([
      priced({ id: 'a', value: 0.5 }),
      { kind: 'NO_PRICE', id: 'b', supplierName: 'Mouser' },
      { kind: 'ERROR', id: 'c', supplierName: 'RS', errorType: 'BLOCKED' },
    ]);
    expect(summary.priceCount).toBe(1);
    expect(summary.noPriceCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    expect(summary.cheapest?.supplierName).toBe('DigiKey');
  });

  it('reports nothing priced for an all-failed run', () => {
    const summary = summarisePriceRefresh([
      { kind: 'ERROR', id: 'a', supplierName: 'DigiKey', errorType: 'NETWORK_TIMEOUT' },
    ]);
    expect(summary.priceCount).toBe(0);
    expect(summary.cheapest).toBeNull();
    expect(summary.errorCount).toBe(1);
  });
});
