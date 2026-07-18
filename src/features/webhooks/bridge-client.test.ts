import { describe, expect, it, vi } from 'vitest';
import {
  fetchWebhookDeliveries,
  mapWebhookFailure,
  sendWebhookTestEvent,
  WEBHOOK_DELIVERIES_PATH,
  WEBHOOK_TEST_PATH,
  type BridgeConnection,
  type FetchLike,
} from './bridge-client';

const BASE_URL = 'http://bridge.test:8787';
const TOKEN = 'placeholder-token-for-tests';

function connection(
  respond: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => { status: number; payload: unknown } | Promise<never>,
): BridgeConnection & { readonly calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  return {
    baseUrl: BASE_URL,
    token: TOKEN,
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const result = await respond(url, init);
      return { status: result.status, json: () => Promise.resolve(result.payload) };
    },
  };
}

const delivery = (overrides: Record<string, unknown> = {}) => ({
  seq: 1,
  at: 1_770_000_000_000,
  targetId: 'wh-1',
  targetName: 'Workshop',
  source: 'database',
  url: 'https://example.com/hooks',
  method: 'POST',
  eventId: 'hist-0001',
  eventType: 'item.created',
  outcome: 'delivered',
  attempts: 1,
  status: 200,
  detail: null,
  ...overrides,
});

describe('mapWebhookFailure', () => {
  it.each([
    [401, 'unauthorised'],
    [403, 'unauthorised'],
    // The bridge makes an absent capability invisible, so a 404 here means "webhooks are off".
    [404, 'not-enabled'],
    [422, 'not-synced'],
    [429, 'rate-limited'],
    [500, 'bridge-unreachable'],
    [418, 'bad-response'],
  ])('maps %i to %s', (status, expected) => {
    expect(mapWebhookFailure(status)).toBe(expected);
  });
});

describe('fetchWebhookDeliveries', () => {
  it('sends the bearer token and asks for a bounded page', async () => {
    const conn = connection(() => ({ status: 200, payload: { deliveries: [], latestSeq: 0 } }));
    await fetchWebhookDeliveries(conn);

    expect(conn.calls[0]!.url).toContain(WEBHOOK_DELIVERIES_PATH);
    expect(conn.calls[0]!.url).toContain('limit=');
    expect(conn.calls[0]!.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(conn.calls[0]!.init.method).toBe('GET');
  });

  it('passes the cursor so a poll only returns what is new', async () => {
    const conn = connection(() => ({ status: 200, payload: { deliveries: [], latestSeq: 7 } }));
    await fetchWebhookDeliveries(conn, 7);
    expect(conn.calls[0]!.url).toContain('since=7');
  });

  it('omits the cursor on a first read', async () => {
    const conn = connection(() => ({ status: 200, payload: { deliveries: [], latestSeq: 0 } }));
    await fetchWebhookDeliveries(conn);
    expect(conn.calls[0]!.url).not.toContain('since=');
  });

  it('reads a page of deliveries', async () => {
    const conn = connection(() => ({
      status: 200,
      payload: { deliveries: [delivery({ seq: 2 }), delivery({ seq: 1 })], latestSeq: 2 },
    }));
    const result = await fetchWebhookDeliveries(conn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestSeq).toBe(2);
    expect(result.deliveries.map((d) => d.seq)).toEqual([2, 1]);
  });

  it('skips an unreadable row rather than blanking the whole page', async () => {
    const conn = connection(() => ({
      status: 200,
      payload: { deliveries: [delivery(), { seq: 'nonsense' }], latestSeq: 2 },
    }));
    const result = await fetchWebhookDeliveries(conn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveries).toHaveLength(1);
  });

  it('rejects a row whose outcome is not one the log defines', async () => {
    const conn = connection(() => ({
      status: 200,
      payload: { deliveries: [delivery({ outcome: 'exploded' })], latestSeq: 1 },
    }));
    const result = await fetchWebhookDeliveries(conn);
    expect(result.ok && result.deliveries).toHaveLength(0);
  });

  it('reports a 404 as webhooks being switched off, not as an empty log', async () => {
    const conn = connection(() => ({ status: 404, payload: { error: 'not_found' } }));
    const result = await fetchWebhookDeliveries(conn);
    expect(result).toEqual({ ok: false, failure: 'not-enabled' });
  });

  it('reports a transport failure without leaking the error or the token', async () => {
    const conn = connection(() => Promise.reject(new Error(`boom ${TOKEN}`)) as Promise<never>);
    const result = await fetchWebhookDeliveries(conn);
    expect(result).toEqual({ ok: false, failure: 'bridge-unreachable' });
  });

  it('treats a blank token as unreachable rather than calling out unauthenticated', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchWebhookDeliveries({ baseUrl: BASE_URL, token: '  ', fetchImpl });
    expect(result).toEqual({ ok: false, failure: 'bridge-unreachable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a response missing its cursor', async () => {
    const conn = connection(() => ({ status: 200, payload: { deliveries: [] } }));
    expect(await fetchWebhookDeliveries(conn)).toEqual({ ok: false, failure: 'bad-response' });
  });
});

describe('sendWebhookTestEvent', () => {
  it('posts the subscription id as JSON', async () => {
    const conn = connection(() => ({
      status: 200,
      payload: { outcome: 'delivered', status: 200, attempts: 1, detail: null, seq: 4 },
    }));
    const result = await sendWebhookTestEvent(conn, 'wh-1');

    expect(conn.calls[0]!.url).toContain(WEBHOOK_TEST_PATH);
    expect(conn.calls[0]!.init.method).toBe('POST');
    expect(conn.calls[0]!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(conn.calls[0]!.init.body!) as unknown).toEqual({ subscriptionId: 'wh-1' });
    expect(result).toEqual({
      ok: true,
      outcome: 'delivered',
      status: 200,
      attempts: 1,
      detail: null,
      seq: 4,
    });
  });

  it('accepts "unmatched" — the matcher ran and said no, which is not a failure', async () => {
    const conn = connection(() => ({
      status: 200,
      payload: { outcome: 'unmatched', status: null, attempts: 0, detail: null, seq: null },
    }));
    const result = await sendWebhookTestEvent(conn, 'wh-1');
    expect(result.ok && result.outcome).toBe('unmatched');
    expect(result.ok && result.seq).toBeNull();
  });

  it('distinguishes "not synced to the bridge yet" from "webhooks are off"', async () => {
    const notSynced = connection(() => ({ status: 422, payload: { error: 'unprocessable' } }));
    expect(await sendWebhookTestEvent(notSynced, 'wh-1')).toEqual({
      ok: false,
      failure: 'not-synced',
    });

    const off = connection(() => ({ status: 404, payload: { error: 'not_found' } }));
    expect(await sendWebhookTestEvent(off, 'wh-1')).toEqual({ ok: false, failure: 'not-enabled' });
  });

  it('rejects an outcome it does not recognise', async () => {
    const conn = connection(() => ({ status: 200, payload: { outcome: 'teleported' } }));
    expect(await sendWebhookTestEvent(conn, 'wh-1')).toEqual({
      ok: false,
      failure: 'bad-response',
    });
  });

  it('does not call the bridge for a blank subscription id', async () => {
    const fetchImpl = vi.fn();
    const result = await sendWebhookTestEvent({ baseUrl: BASE_URL, token: TOKEN, fetchImpl }, '  ');
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
