import { describe, expect, it, vi } from 'vitest';
import {
  SCALE_STREAM_PATH,
  watchScaleReadings,
  type ScaleSample,
  type ScaleStreamEnd,
  type StreamFetchLike,
} from './scale-stream';

const CONNECTION = { baseUrl: 'http://bridge.test:8787', token: 'placeholder-bridge-token' };

/** A `ReadableStream` over the given chunks, so a test can script exactly what the bridge writes. */
function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return void controller.close();
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
}

/** A streaming `fetch` that answers 200 with the given chunks, recording the request it saw. */
function streamingFetch(chunks: readonly string[]) {
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const fetchImpl: StreamFetchLike = async (url, init) => {
    seen.url = url;
    seen.headers = init.headers;
    return { status: 200, json: async () => undefined, body: bodyOf(chunks) };
  };
  return { fetchImpl, seen };
}

/** Run a subscription to completion, collecting the samples and the end reason. */
async function watch(
  fetchImpl: StreamFetchLike,
  entityId = 'sensor.bench_scale',
  signal = new AbortController().signal,
): Promise<{ samples: ScaleSample[]; end: ScaleStreamEnd | null }> {
  const samples: ScaleSample[] = [];
  let end: ScaleStreamEnd | null = null;
  await watchScaleReadings({
    connection: { ...CONNECTION, fetchImpl },
    entityId,
    onSample: (sample) => samples.push(sample),
    onEnd: (reason) => {
      end = reason;
    },
    signal,
  });
  return { samples, end };
}

const READING =
  '{"ok":true,"reading":{"entityId":"sensor.bench_scale","grams":1250,"value":1.25,"unit":"kg"}}';

describe('watchScaleReadings', () => {
  it('sends the bearer token in a header, never in the URL', async () => {
    const { fetchImpl, seen } = streamingFetch([`data: ${READING}\n\n`]);
    await watch(fetchImpl);
    expect(seen.url).toBe(`${CONNECTION.baseUrl}${SCALE_STREAM_PATH}?entity_id=sensor.bench_scale`);
    expect(seen.url).not.toContain('placeholder-bridge-token');
    expect(seen.headers?.authorization).toBe('Bearer placeholder-bridge-token');
  });

  it('reports each reading in canonical grams', async () => {
    const { fetchImpl } = streamingFetch([
      ': connected\n\n',
      `data: ${READING}\n\n`,
      'data: {"ok":true,"reading":{"entityId":"sensor.bench_scale","grams":1300,"value":1.3,"unit":"kg"}}\n\n',
    ]);
    const { samples, end } = await watch(fetchImpl);
    expect(samples).toEqual([
      { ok: true, grams: 1250, value: 1.25, unit: 'kg' },
      { ok: true, grams: 1300, value: 1.3, unit: 'kg' },
    ]);
    expect(end).toEqual({ failure: null });
  });

  // The socket splits where it likes; a frame must survive being cut in half, including mid-JSON.
  it('reassembles a frame split across chunks', async () => {
    const frame = `data: ${READING}\n\n`;
    const { fetchImpl } = streamingFetch([frame.slice(0, 30), frame.slice(30)]);
    const { samples } = await watch(fetchImpl);
    expect(samples).toEqual([{ ok: true, grams: 1250, value: 1.25, unit: 'kg' }]);
  });

  it('ignores comment frames, so a heartbeat is not mistaken for a reading', async () => {
    const { fetchImpl } = streamingFetch([': connected\n\n', ': heartbeat\n\n']);
    const { samples, end } = await watch(fetchImpl);
    expect(samples).toEqual([]);
    expect(end).toEqual({ failure: null });
  });

  // A live failure and a one-shot failure must be explained in the same words.
  it('maps a failure frame onto the reasons the dialog already renders', async () => {
    const { fetchImpl } = streamingFetch([
      'data: {"ok":false,"issue":"unavailable"}\n\n',
      'data: {"ok":false,"issue":"home-assistant-unreachable"}\n\n',
      'data: {"ok":false,"issue":"gone"}\n\n',
    ]);
    const { samples } = await watch(fetchImpl);
    expect(samples).toEqual([
      { ok: false, failure: 'scale-unavailable' },
      { ok: false, failure: 'home-assistant-unreachable' },
      { ok: false, failure: 'not-a-number' },
    ]);
  });

  // Interrupting a live watch over one bad line is a worse answer than a 250 ms gap.
  it('drops an unreadable frame rather than ending the stream', async () => {
    const { fetchImpl } = streamingFetch(['data: not json\n\n', `data: ${READING}\n\n`]);
    const { samples, end } = await watch(fetchImpl);
    expect(samples).toEqual([{ ok: true, grams: 1250, value: 1.25, unit: 'kg' }]);
    expect(end).toEqual({ failure: null });
  });

  it('reports a reading whose numbers are unusable as a bad response', async () => {
    const { fetchImpl } = streamingFetch(['data: {"ok":true,"reading":{"grams":"heavy"}}\n\n']);
    const { samples } = await watch(fetchImpl);
    expect(samples).toEqual([{ ok: false, failure: 'bad-response' }]);
  });

  it('refuses to open without a chosen scale', async () => {
    const fetchImpl = vi.fn();
    const { end } = await watch(fetchImpl as unknown as StreamFetchLike, '  ');
    expect(end).toEqual({ failure: 'no-entity' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a non-2xx answer through the same failure table as a one-shot read', async () => {
    const fetchImpl: StreamFetchLike = async () => ({
      status: 404,
      json: async () => ({ error: { code: 'not_found' } }),
      body: null,
    });
    const { end } = await watch(fetchImpl);
    expect(end).toEqual({ failure: 'not-enabled' });
  });

  it('reports an unreachable bridge rather than throwing', async () => {
    const fetchImpl: StreamFetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { samples, end } = await watch(fetchImpl);
    expect(samples).toEqual([]);
    expect(end).toEqual({ failure: 'bridge-unreachable' });
  });

  // Closing the dialog is the caller's own doing, so it must not surface as an error.
  it('ends quietly when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl: StreamFetchLike = async (_url, init) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal });
    };
    const { end } = await watch(fetchImpl, 'sensor.bench_scale', controller.signal);
    expect(end).toEqual({ failure: null });
  });

  it('reports a stream the bridge answered without a body', async () => {
    const fetchImpl: StreamFetchLike = async () => ({ status: 200, json: async () => undefined, body: null });
    const { end } = await watch(fetchImpl);
    expect(end).toEqual({ failure: 'bad-response' });
  });
});
