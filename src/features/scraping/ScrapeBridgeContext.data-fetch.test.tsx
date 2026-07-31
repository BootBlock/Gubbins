/**
 * `fetchDataUrl` — the one bridge call that resolves a promise instead of settling into
 * {@link BridgeState} (issue #616).
 *
 * Its caller is the pure lookup runner, which serialises requests through a promise chain and has
 * no render state to watch, so the correlation happens in a ref rather than in the reducer. That
 * makes three things worth pinning, because none of them is visible in the reducer's own tests:
 *
 * - a reply is matched by **both** the correlation id and the URL;
 * - a request the extension never answers resolves (as `null`) rather than hanging forever;
 * - and unmounting settles anything still outstanding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ScrapeBridgeProvider, useScrapeBridge, type DataFetchOutcome } from './ScrapeBridgeContext';
import { makeMessage } from './protocol';

const URL_A = 'https://www.wikidata.org/w/api.php?action=wbsearchentities';
const URL_B = 'https://query.wikidata.org/sparql?query=x';

let bridge: ReturnType<typeof useScrapeBridge>;

function Probe() {
  bridge = useScrapeBridge();
  return null;
}

/** Deliver a message into the page exactly as the content script would. */
function deliver(message: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: window.location.origin }));
  });
}

/** The correlation id the provider stamped on the outgoing request. */
function sentRequestId(post: ReturnType<typeof vi.fn>, index = 0): string {
  const msg = post.mock.calls[index]![0] as { type: string; requestId: string };
  expect(msg.type).toBe('DATA_FETCH_REQUEST');
  return msg.requestId;
}

let post: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  post = vi.fn();
  vi.spyOn(window, 'postMessage').mockImplementation(post as unknown as typeof window.postMessage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchDataUrl', () => {
  it('posts a DATA_FETCH_REQUEST and resolves with the body the extension returns', async () => {
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });

    const id = sentRequestId(post);
    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_A, body: '{"search":[]}' }, id));
    await pending;
    expect(settled).toEqual({ ok: true, body: '{"search":[]}' });
  });

  it('resolves a DATA_FETCH_ERROR as a typed failure rather than throwing', async () => {
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });

    const error = { domain: 'www.wikidata.org', error_type: 'RATE_LIMITED' as const, reason: 'slow down' };
    deliver(makeMessage('DATA_FETCH_ERROR', error, sentRequestId(post)));
    await pending;
    expect(settled).toEqual({ ok: false, error });
  });

  it('ignores a reply whose URL is not the one this request asked for', async () => {
    // The id alone is not enough: a reply carrying a different URL is not an answer to this
    // request, whatever id it echoes.
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });

    deliver(
      makeMessage('DATA_FETCH_RESULT', { url: URL_B, body: 'someone else’s answer' }, sentRequestId(post)),
    );
    await pending;
    expect(settled).toBeNull();
  });

  it('ignores an unknown or already-settled correlation id', async () => {
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });
    const id = sentRequestId(post);

    // A stale/foreign echo changes nothing…
    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_A, body: 'stale' }, 'never-requested'));
    // …then the real reply settles it, and a re-delivery of it is dropped.
    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_A, body: 'real' }, id));
    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_A, body: 'again' }, id));
    await pending;
    expect(settled).toEqual({ ok: true, body: 'real' });
  });

  it('routes two concurrent requests to their own callers', async () => {
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    const first = bridge.fetchDataUrl(URL_A);
    const second = bridge.fetchDataUrl(URL_B);
    const idA = sentRequestId(post, 0);
    const idB = sentRequestId(post, 1);
    expect(idA).not.toBe(idB);

    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_B, body: 'B' }, idB));
    deliver(makeMessage('DATA_FETCH_RESULT', { url: URL_A, body: 'A' }, idA));
    expect(await first).toEqual({ ok: true, body: 'A' });
    expect(await second).toEqual({ ok: true, body: 'B' });
  });

  it('resolves null when the extension never answers, rather than hanging forever', async () => {
    // An older extension build has no `DATA_FETCH_REQUEST` handler at all, so silence is a real
    // outcome — and indistinguishable from a slow network unless it is timed out.
    render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined = undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });
    expect(settled).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await pending;
    expect(settled).toBeNull();
  });

  it('settles anything outstanding when the provider unmounts', async () => {
    const view = render(
      <ScrapeBridgeProvider>
        <Probe />
      </ScrapeBridgeProvider>,
    );
    let settled: DataFetchOutcome | null | undefined = undefined;
    const pending = bridge.fetchDataUrl(URL_A).then((outcome) => {
      settled = outcome;
    });

    act(() => view.unmount());
    await pending;
    expect(settled).toBeNull();
  });
});
