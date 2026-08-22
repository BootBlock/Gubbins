/**
 * Every tracked bridge request has a deadline (issue #665).
 *
 * The §9.1 receiving side drops an invalid message silently, so a request the peer refuses — a
 * URL that fails the wire schema, an extension disabled mid-session, a build too old to know the
 * request kind — produces no reply at all. Without a deadline the reducer entry stays `SCRAPING`
 * for the rest of the session, disabling the panel's button with nothing to act on. These pin the
 * guard the bridge now applies to both request kinds, and that it never fires on a settled one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { BRIDGE_REQUEST_TIMEOUT_MS, ScrapeBridgeProvider, useScrapeBridge } from './ScrapeBridgeContext';
import { OPEN_FOOD_FACTS_HOST } from './product-lookup';
import { makeMessage } from './protocol';

const SUPPLIER_URL = 'https://www.digikey.co.uk/en/products/detail/x';

let bridge: ReturnType<typeof useScrapeBridge>;

function Probe() {
  bridge = useScrapeBridge();
  return null;
}

function deliver(message: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: window.location.origin }));
  });
}

/** Advance past the deadline, flushing the dispatch it schedules. */
function expire(): void {
  act(() => {
    vi.advanceTimersByTime(BRIDGE_REQUEST_TIMEOUT_MS);
  });
}

/**
 * How many timers are pending. Reducer state cannot show a *cancelled* deadline — the reducer
 * declines a late settle anyway — so a disarm is only observable here. Without this, a test that
 * removed every `disarm` call would still pass.
 */
function armedDeadlines(): number {
  return vi.getTimerCount();
}

let post: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  post = vi.fn();
  vi.spyOn(window, 'postMessage').mockImplementation(post as unknown as typeof window.postMessage);
  render(
    <ScrapeBridgeProvider>
      <Probe />
    </ScrapeBridgeProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scrape request deadline', () => {
  it('settles an unanswered scrape as NETWORK_TIMEOUT naming the target host', () => {
    let id = '';
    act(() => {
      id = bridge.requestScrape(SUPPLIER_URL);
    });
    expect(bridge.requests[id]?.status).toBe('SCRAPING');
    expect(bridge.pendingCount).toBe(1);

    expire();

    expect(bridge.requests[id]?.status).toBe('ERROR');
    expect(bridge.requests[id]?.error?.error_type).toBe('NETWORK_TIMEOUT');
    expect(bridge.requests[id]?.error?.domain).toBe('www.digikey.co.uk');
    // The whole point: the panel's "Scraping…" state ends, so its button is usable again.
    expect(bridge.pendingCount).toBe(0);
  });

  it('reports the raw target when it is not a parseable URL, rather than an empty domain', () => {
    let id = '';
    act(() => {
      id = bridge.requestScrape('digikey.co.uk/product/123');
    });
    expire();
    expect(bridge.requests[id]?.error?.domain).toBe('digikey.co.uk/product/123');
  });

  it('disarms the deadline of a scrape that answered, and leaves its outcome alone', () => {
    let id = '';
    act(() => {
      id = bridge.requestScrape(SUPPLIER_URL);
    });
    expect(armedDeadlines()).toBe(1);
    deliver(
      makeMessage(
        'SCRAPE_RESULT',
        {
          mpn: 'ABC-123',
          manufacturer: 'Acme',
          description: 'A part',
          distributor_url: SUPPLIER_URL,
          scraped_pricing: { currency: 'GBP', value: 1.5 },
        },
        id,
      ),
    );
    expect(bridge.requests[id]?.status).toBe('SUCCESS');
    // The reply cancelled the deadline rather than leaving it to fire into a settled entry.
    expect(armedDeadlines()).toBe(0);

    expire();

    expect(bridge.requests[id]?.status).toBe('SUCCESS');
    expect(bridge.requests[id]?.error).toBeNull();
  });

  it('drops the deadline with the request when it is cleared before expiry', () => {
    let id = '';
    act(() => {
      id = bridge.requestScrape(SUPPLIER_URL);
    });
    expect(armedDeadlines()).toBe(1);
    act(() => {
      bridge.clear(id);
    });
    // Clearing an abandoned request takes its deadline with it, rather than leaving a timer to
    // fire minutes later into a provider that no longer tracks it.
    expect(armedDeadlines()).toBe(0);
    expire();
    expect(bridge.requests[id]).toBeUndefined();
  });
});

describe('product lookup deadline', () => {
  it('settles an unanswered lookup as NETWORK_TIMEOUT naming the product database', () => {
    let id = '';
    act(() => {
      id = bridge.requestLookup('4006381333931');
    });
    expect(bridge.lookups[id]?.status).toBe('LOOKING_UP');

    expire();

    expect(bridge.lookups[id]?.status).toBe('ERROR');
    expect(bridge.lookups[id]?.error?.error_type).toBe('NETWORK_TIMEOUT');
    expect(bridge.lookups[id]?.error?.domain).toBe(OPEN_FOOD_FACTS_HOST);
  });

  it('disarms the deadline of a lookup that answered, and leaves its outcome alone', () => {
    let id = '';
    act(() => {
      id = bridge.requestLookup('4006381333931');
    });
    deliver(
      makeMessage(
        'PRODUCT_LOOKUP_ERROR',
        { domain: OPEN_FOOD_FACTS_HOST, error_type: 'NOT_FOUND', reason: 'x' },
        id,
      ),
    );
    expect(armedDeadlines()).toBe(0);
    expire();
    expect(bridge.lookups[id]?.error?.error_type).toBe('NOT_FOUND');
  });

  it('keeps the deadline when a reply of the wrong kind carries the id', () => {
    // The reducer routes a reply by kind *and* id, so a SCRAPE_RESULT bearing a lookup's id
    // settles nothing. A disarm matching on the id alone would still cancel that lookup's
    // deadline, leaving it pending forever — the very hang the deadline exists to prevent.
    let id = '';
    act(() => {
      id = bridge.requestLookup('4006381333931');
    });
    deliver(
      makeMessage(
        'SCRAPE_RESULT',
        {
          mpn: 'ABC-123',
          manufacturer: 'Acme',
          description: 'A part',
          distributor_url: SUPPLIER_URL,
          scraped_pricing: null,
        },
        id,
      ),
    );
    expect(bridge.lookups[id]?.status).toBe('LOOKING_UP');
    expect(armedDeadlines()).toBe(1);

    expire();

    expect(bridge.lookups[id]?.status).toBe('ERROR');
    expect(bridge.lookups[id]?.error?.error_type).toBe('NETWORK_TIMEOUT');
  });
});
