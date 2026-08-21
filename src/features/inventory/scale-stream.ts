/**
 * Watching a Home Assistant scale live (issue #125) — the PWA half of the bridge's
 * `GET /api/v1/scale/stream`.
 *
 * `scale-reading.ts` fetches one reading; this subscribes to them. Everything downstream is
 * unchanged: the samples feed the same `weigh-count` arithmetic, through the same gross-weight
 * field, and **a live reading is never applied automatically** — the user still confirms, exactly
 * as they do for a typed figure. That keeps manual entry the default path and means an unsettled
 * or chattering scale can never write stock on its own.
 *
 * **`fetch` rather than `EventSource`.** `EventSource` cannot set an `Authorization` header, so
 * using it would mean widening the bridge's token-in-URL allowance (today scoped to the calendar
 * and syndication feeds, which have no other way to authenticate) to a path that does not need it.
 * Reading the body as a stream keeps the bearer token in the header where every other bridge call
 * puts it, and an `AbortSignal` closes the subscription the moment the dialog does.
 *
 * Transport-only and side-effect-free in the same shape as its sibling: it takes `fetch`, hands
 * back parsed frames, and every failure arrives as a {@link ScaleFailure} the React layer turns
 * into a translated sentence — no message here is ever shown to a user, and none carries the token.
 */
import {
  buildScaleRequest,
  mapScaleFailure,
  type BridgeConnection,
  type ScaleFailure,
} from './scale-reading';

/** The bridge's live-reading endpoint, appended to the user's configured base URL. */
export const SCALE_STREAM_PATH = '/api/v1/scale/stream';

/**
 * One sample off the stream: a weight in canonical grams, or the reason there isn't one.
 *
 * The bridge's own `issue` vocabulary is mapped onto the {@link ScaleFailure} set the dialog
 * already renders, so a live failure and a one-shot failure are explained in the same words —
 * there is no second vocabulary of live-only messages to keep translated.
 */
export type ScaleSample =
  | { readonly ok: true; readonly grams: number; readonly value: number; readonly unit: string }
  | { readonly ok: false; readonly failure: ScaleFailure };

/** How a subscription finished: cleanly (the caller aborted), or because something went wrong. */
export type ScaleStreamEnd = { readonly failure: ScaleFailure | null };

/** A minimal streaming `fetch`, so tests inject a fake without the DOM lib types. */
export type StreamFetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}>;

/** Everything a subscription needs: where the bridge is, which sensor, and where samples go. */
export interface ScaleStreamOptions {
  readonly connection: Omit<BridgeConnection, 'fetchImpl'> & { readonly fetchImpl: StreamFetchLike };
  readonly entityId: string;
  /** Called for every sample, in arrival order. Never called after {@link onEnd}. */
  readonly onSample: (sample: ScaleSample) => void;
  /** Called exactly once, when the stream stops for any reason. */
  readonly onEnd: (end: ScaleStreamEnd) => void;
  /** Closes the subscription. Aborting is the *only* way a caller ends one. */
  readonly signal: AbortSignal;
}

/**
 * The bridge's frame vocabulary → the reasons the dialog already knows how to say.
 *
 * `gone` is mapped to `not-a-number` rather than a reason of its own: from the user's seat, a
 * sensor that has stopped being a readable scale mid-watch and one that never reported a weight
 * call for the same check — is that really the scale? Adding a further reason would add a string
 * without adding an action.
 */
const FRAME_FAILURES: Readonly<Record<string, ScaleFailure>> = {
  unavailable: 'scale-unavailable',
  'not-a-number': 'not-a-number',
  'home-assistant-unreachable': 'home-assistant-unreachable',
  'home-assistant-unauthorised': 'home-assistant-unreachable',
  'home-assistant-error': 'home-assistant-unreachable',
  gone: 'not-a-number',
};

/**
 * Subscribe to a scale's live readings until the caller's signal aborts, the bridge ends the
 * stream, or it fails. Resolves when the subscription is over; {@link ScaleStreamOptions.onEnd}
 * has already been called by then.
 */
export async function watchScaleReadings(options: ScaleStreamOptions): Promise<void> {
  const { connection, entityId, onSample, onEnd, signal } = options;

  const trimmed = entityId.trim();
  if (trimmed === '') return void onEnd({ failure: 'no-entity' });

  let request: ReturnType<typeof buildScaleRequest>;
  try {
    request = buildScaleRequest(
      connection.baseUrl,
      connection.token,
      `${SCALE_STREAM_PATH}?entity_id=${encodeURIComponent(trimmed)}`,
    );
  } catch {
    // A blank/malformed URL or token is indistinguishable, from here, from a bridge we can't
    // reach — and the fix is the same screen either way.
    return void onEnd({ failure: 'bridge-unreachable' });
  }

  let response: Awaited<ReturnType<StreamFetchLike>>;
  try {
    response = await connection.fetchImpl(request.url, {
      method: 'GET',
      headers: { ...request.headers, accept: 'text/event-stream' },
      signal,
    });
  } catch {
    // An abort lands here too, and is the caller's own doing rather than something to report.
    return void onEnd({ failure: signal.aborted ? null : 'bridge-unreachable' });
  }

  if (response.status < 200 || response.status >= 300) {
    const payload = await response.json().catch(() => undefined);
    return void onEnd({ failure: mapScaleFailure(response.status, payload) });
  }
  if (response.body === null) return void onEnd({ failure: 'bad-response' });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // Keep the trailing fragment: a chunk can split a frame anywhere, including mid-JSON.
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        // `:` lines are SSE comments (the bridge's `connected` marker and its heartbeats), and
        // there is no `id:`/`retry:` to honour — a reconnect must never replay a stale weight.
        if (!line.startsWith('data: ')) continue;
        const sample = readFrame(line.slice(6));
        if (sample !== null) onSample(sample);
      }
    }
  } catch {
    return void onEnd({ failure: signal.aborted ? null : 'bridge-unreachable' });
  } finally {
    // Releasing rather than cancelling: an aborted `fetch` has already torn the body down, and
    // cancelling a released reader throws.
    try {
      reader.releaseLock();
    } catch {
      // The stream is going away regardless.
    }
  }
  // The bridge closed the stream — it does that when the entity stops being a readable scale, and
  // has already sent the frame explaining why, so there is nothing further to report here.
  onEnd({ failure: null });
}

/**
 * Parse one `data:` payload into a sample, or `null` when it is not one we can use.
 *
 * A frame we cannot read is dropped rather than surfaced: the next sample is 250 ms away, and
 * interrupting a live watch over one malformed line would be a worse answer than a brief gap.
 */
function readFrame(payload: string): ScaleSample | null {
  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;
  const record = frame as Record<string, unknown>;

  if (record.ok === false) {
    const issue = typeof record.issue === 'string' ? record.issue : '';
    return { ok: false, failure: FRAME_FAILURES[issue] ?? 'bad-response' };
  }
  if (record.ok !== true) return null;

  const reading = record.reading;
  if (typeof reading !== 'object' || reading === null) return { ok: false, failure: 'bad-response' };
  const { grams, value, unit } = reading as Record<string, unknown>;
  if (
    typeof grams !== 'number' ||
    !Number.isFinite(grams) ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    typeof unit !== 'string' ||
    unit.length === 0
  ) {
    return { ok: false, failure: 'bad-response' };
  }
  return { ok: true, grams, value, unit };
}
