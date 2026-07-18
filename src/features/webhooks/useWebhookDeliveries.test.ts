import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_VISIBLE_DELIVERIES,
  useWebhookDeliveries,
  WEBHOOK_POLL_INTERVAL_MS,
} from './useWebhookDeliveries';
import type { BridgeConnection } from './bridge-client';

const delivery = (seq: number) => ({
  seq,
  at: 1_770_000_000_000 + seq,
  targetId: 'wh-1',
  targetName: 'Workshop',
  source: 'database',
  url: 'https://example.com/hooks',
  method: 'POST',
  eventId: `hist-${String(seq)}`,
  eventType: 'item.created',
  outcome: 'delivered',
  attempts: 1,
  status: 200,
  detail: null,
});

/**
 * A connection whose `fetchImpl` identity is stable, exactly as the screen's memoised one is.
 * Recording the URLs is how the "does it re-arm?" assertions are made.
 */
function stableConnection(
  respond: (url: string) => { deliveries: unknown[]; latestSeq: number },
  status = 200,
): BridgeConnection & { readonly urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (url: string) => {
    urls.push(url);
    return Promise.resolve({ status, json: () => Promise.resolve(respond(url)) });
  };
  return { baseUrl: 'http://bridge.test:8787', token: 'placeholder-token', fetchImpl, urls };
}

/** Flush the pending poll promise chain under fake timers. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useWebhookDeliveries', () => {
  it('stays unconfigured without a bridge', async () => {
    const { result } = renderHook(() => useWebhookDeliveries(null));
    await settle();
    expect(result.current.state.status).toBe('unconfigured');
  });

  it('polls once on mount and reports the page', async () => {
    const conn = stableConnection(() => ({ deliveries: [delivery(1)], latestSeq: 1 }));
    const { result } = renderHook(() => useWebhookDeliveries(conn));
    await settle();

    expect(conn.urls).toHaveLength(1);
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.status === 'ready' && result.current.state.deliveries).toHaveLength(1);
  });

  /**
   * The regression this file exists for: with a stable connection the effect must arm the interval
   * exactly once. When the screen rebuilt its `fetchImpl` on every render, the effect re-armed on
   * each one and the component spun.
   */
  it('does not re-arm the poll when the component re-renders', async () => {
    const conn = stableConnection(() => ({ deliveries: [], latestSeq: 0 }));
    const { rerender } = renderHook(() => useWebhookDeliveries(conn));
    await settle();
    const afterMount = conn.urls.length;

    rerender();
    rerender();
    rerender();
    await settle();

    expect(conn.urls.length).toBe(afterMount);
  });

  it('passes the cursor on later polls so only new rows come back', async () => {
    const conn = stableConnection(() => ({ deliveries: [delivery(3)], latestSeq: 3 }));
    renderHook(() => useWebhookDeliveries(conn));
    await settle();
    expect(conn.urls[0]).not.toContain('since=');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
    });
    expect(conn.urls[1]).toContain('since=3');
  });

  it('stops polling once unmounted — the screen being open is the subscription', async () => {
    const conn = stableConnection(() => ({ deliveries: [], latestSeq: 0 }));
    const { unmount } = renderHook(() => useWebhookDeliveries(conn));
    await settle();
    const before = conn.urls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS * 3);
    });

    expect(conn.urls.length).toBe(before);
  });

  it('caps how many rows it keeps on screen', async () => {
    let seq = 0;
    const conn = stableConnection(() => {
      seq += 1;
      return { deliveries: [delivery(seq)], latestSeq: seq };
    });
    const { result } = renderHook(() => useWebhookDeliveries(conn));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS * (MAX_VISIBLE_DELIVERIES + 5));
    });

    const { state } = result.current;
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.deliveries.length).toBeLessThanOrEqual(MAX_VISIBLE_DELIVERIES);
  });

  it('surfaces a failure rather than an empty log', async () => {
    const conn = stableConnection(() => ({ deliveries: [], latestSeq: 0 }), 404);
    const { result } = renderHook(() => useWebhookDeliveries(conn));
    await settle();

    expect(result.current.state.status).toBe('failed');
    expect(result.current.state.status === 'failed' && result.current.state.failure).toBe('not-enabled');
  });
});
