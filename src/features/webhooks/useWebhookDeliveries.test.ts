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
  respond: (url: string) => { deliveries: unknown[]; latestSeq: number; logId?: string },
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

  /**
   * Issue #645. The log lives in bridge memory and its sequence numbers count from zero again on
   * every start, so a cursor held across a restart addresses records that no longer exist: the
   * bridge answers "nothing after 5" and the rows it *does* hold are never asked for again.
   */
  describe('when the bridge restarts underneath the cursor', () => {
    it('re-reads the new log from the start instead of losing its first rows', async () => {
      let logId = 'log-a';
      const conn = stableConnection((url) => {
        if (logId === 'log-a') return { deliveries: [delivery(5)], latestSeq: 5, logId };
        // The restarted log holds three records and knows nothing of the old cursor.
        const all = [delivery(3), delivery(2), delivery(1)];
        return {
          deliveries: url.includes('since=') ? [] : all,
          latestSeq: 3,
          logId,
        };
      });
      const { result } = renderHook(() => useWebhookDeliveries(conn));
      await settle();

      logId = 'log-b';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });

      // The cursor'd poll answered nothing, so a second, cursor-free read was made.
      expect(conn.urls).toHaveLength(3);
      expect(conn.urls[1]).toContain('since=5');
      expect(conn.urls[2]).not.toContain('since=');

      const { state } = result.current;
      expect(state.status).toBe('ready');
      if (state.status !== 'ready') throw new Error('expected a ready log');
      // The pre-restart row is gone (it is not in the new log) and all three new ones are shown.
      expect(state.deliveries.map((entry) => entry.delivery.seq)).toEqual([3, 2, 1]);
      expect(state.restarted).toBe(true);
    });

    it('never re-uses a row key, so old and new rows cannot collide', async () => {
      const keys: string[] = [];
      let logId = 'log-a';
      const conn = stableConnection((url) =>
        logId === 'log-a'
          ? { deliveries: [delivery(1)], latestSeq: 1, logId }
          : { deliveries: url.includes('since=') ? [] : [delivery(1)], latestSeq: 1, logId },
      );
      const { result } = renderHook(() => useWebhookDeliveries(conn));
      await settle();
      if (result.current.state.status !== 'ready') throw new Error('expected a ready log');
      keys.push(...result.current.state.deliveries.map((entry) => entry.key));

      logId = 'log-b';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });
      if (result.current.state.status !== 'ready') throw new Error('expected a ready log');
      keys.push(...result.current.state.deliveries.map((entry) => entry.key));

      // Both rows are `seq` 1 — from two different logs — so the keys must still differ.
      expect(new Set(keys).size).toBe(keys.length);
    });

    /** A bridge too old to report a `logId` still gives one unambiguous signal: a cursor that ran backwards. */
    it('falls back to a latestSeq that went backwards when the bridge reports no log id', async () => {
      let restarted = false;
      const conn = stableConnection((url) => {
        if (!restarted) return { deliveries: [delivery(5)], latestSeq: 5 };
        return { deliveries: url.includes('since=') ? [] : [delivery(2), delivery(1)], latestSeq: 2 };
      });
      const { result } = renderHook(() => useWebhookDeliveries(conn));
      await settle();

      restarted = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });

      expect(conn.urls[2]).not.toContain('since=');
      const { state } = result.current;
      if (state.status !== 'ready') throw new Error('expected a ready log');
      expect(state.deliveries.map((entry) => entry.delivery.seq)).toEqual([2, 1]);
      expect(state.restarted).toBe(true);
    });

    it('leaves an ordinary quiet poll alone', async () => {
      const conn = stableConnection((url) => ({
        deliveries: url.includes('since=') ? [] : [delivery(5)],
        latestSeq: 5,
        logId: 'log-a',
      }));
      const { result } = renderHook(() => useWebhookDeliveries(conn));
      await settle();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });

      expect(conn.urls).toHaveLength(2);
      const { state } = result.current;
      if (state.status !== 'ready') throw new Error('expected a ready log');
      expect(state.deliveries).toHaveLength(1);
      expect(state.restarted).toBe(false);
    });

    /**
     * "The screen being open is the subscription" (the module's own rule) has to survive the second
     * request the restart branch makes. Without a check after each await, a poll that resolves
     * after the screen closed would fire a fresh one at a bridge nobody is watching.
     */
    it('starts no follow-up request once the screen has closed', async () => {
      const urls: string[] = [];
      let release: (() => void) | undefined;
      const conn: BridgeConnection & { readonly urls: string[] } = {
        baseUrl: 'http://bridge.test:8787',
        token: 'placeholder-token',
        urls,
        fetchImpl: (url: string) => {
          urls.push(url);
          if (urls.length === 1) {
            return Promise.resolve({
              status: 200,
              json: () => Promise.resolve({ deliveries: [delivery(5)], latestSeq: 5, logId: 'log-a' }),
            });
          }
          // Held open until the screen has gone, so the restart is detected too late to act on.
          return new Promise((resolve) => {
            release = () =>
              resolve({
                status: 200,
                json: () => Promise.resolve({ deliveries: [], latestSeq: 1, logId: 'log-b' }),
              });
          });
        },
      };
      const { unmount } = renderHook(() => useWebhookDeliveries(conn));
      await settle();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });
      expect(urls).toHaveLength(2);

      unmount();
      await act(async () => {
        release?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(urls).toHaveLength(2);
    });

    /**
     * The companion to the check above, on the *second* request: the re-read of the restarted log
     * lands after the user has pointed the screen at a different bridge. Those rows belong to a
     * bridge that is no longer on screen, so they must not be shown as this one's.
     */
    it('discards a re-read that lands after the bridge has changed', async () => {
      let release: (() => void) | undefined;
      let calls = 0;
      const first: BridgeConnection = {
        baseUrl: 'http://bridge.test:8787',
        token: 'placeholder-token-a',
        fetchImpl: () => {
          calls += 1;
          // 1: the mount's read. 2: the cursor'd poll, answered by a log that has restarted.
          if (calls === 1) {
            return Promise.resolve({
              status: 200,
              json: () => Promise.resolve({ deliveries: [delivery(5)], latestSeq: 5, logId: 'log-a' }),
            });
          }
          if (calls === 2) {
            return Promise.resolve({
              status: 200,
              json: () => Promise.resolve({ deliveries: [], latestSeq: 1, logId: 'log-b' }),
            });
          }
          // 3: the re-read of the new log, held open until the screen has moved on.
          return new Promise((resolve) => {
            release = () =>
              resolve({
                status: 200,
                json: () => Promise.resolve({ deliveries: [delivery(9)], latestSeq: 9, logId: 'log-b' }),
              });
          });
        },
      };
      // The bridge the user switches to never answers, so anything reaching the screen after the
      // switch could only have come from the first one.
      let secondCalls = 0;
      const second: BridgeConnection = {
        baseUrl: 'http://other.test:8787',
        token: 'placeholder-token-b',
        fetchImpl: () => {
          secondCalls += 1;
          return new Promise(() => {});
        },
      };

      const { result, rerender } = renderHook(
        ({ connection }: { connection: BridgeConnection }) => useWebhookDeliveries(connection),
        { initialProps: { connection: first } },
      );
      await settle();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });
      expect(calls).toBe(3);

      rerender({ connection: second });
      await settle();
      // The new bridge is read at once. A request still in flight for the old one must not hold
      // the slot, or the screen would sit on "loading" until the next tick ten seconds later.
      expect(secondCalls).toBe(1);
      await act(async () => {
        release?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      // Still waiting on the new bridge — the old bridge's re-read was thrown away.
      expect(result.current.state.status).toBe('loading');
    });

    it('reports the failure when the re-read itself fails', async () => {
      let logId = 'log-a';
      let failRead = false;
      const urls: string[] = [];
      const conn: BridgeConnection & { readonly urls: string[] } = {
        baseUrl: 'http://bridge.test:8787',
        token: 'placeholder-token',
        urls,
        fetchImpl: (url: string) => {
          urls.push(url);
          const cursorFree = !url.includes('since=');
          if (failRead && cursorFree) {
            return Promise.resolve({ status: 401, json: () => Promise.resolve({}) });
          }
          return Promise.resolve({
            status: 200,
            json: () => Promise.resolve({ deliveries: cursorFree ? [delivery(1)] : [], latestSeq: 1, logId }),
          });
        },
      };
      const { result } = renderHook(() => useWebhookDeliveries(conn));
      await settle();

      logId = 'log-b';
      failRead = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WEBHOOK_POLL_INTERVAL_MS);
      });

      expect(result.current.state.status).toBe('failed');
      expect(result.current.state.status === 'failed' && result.current.state.failure).toBe('unauthorised');
    });
  });

  it('surfaces a failure rather than an empty log', async () => {
    const conn = stableConnection(() => ({ deliveries: [], latestSeq: 0 }), 404);
    const { result } = renderHook(() => useWebhookDeliveries(conn));
    await settle();

    expect(result.current.state.status).toBe('failed');
    expect(result.current.state.status === 'failed' && result.current.state.failure).toBe('not-enabled');
  });
});
