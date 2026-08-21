/**
 * Live scale readings over server-sent events (issue #125, phase 1) —
 * `GET /api/v1/scale/stream?entity_id=…`.
 *
 * The one-shot `GET /api/v1/scale/state` answers "what does the scale say *now*". This answers
 * "tell me as it changes", so the weigh-count dialog can watch a count settle while parts land on
 * the pan instead of the user pressing a button after each handful.
 *
 * **Why this is a separate endpoint rather than an event on the existing bus.** `events/sse.ts`
 * is fed by the ledger-derived event pipeline, and that pipeline fans out to three sinks — SSE,
 * webhooks *and* MQTT. A live weight sensor placed on it would be delivered to every webhook
 * endpoint and MQTT topic the operator has configured, at sensor frequency. That is wrong on
 * volume grounds and wrong on privacy grounds, so this reuses the *transport technique* (a
 * long-lived `text/event-stream` response, a concurrent-client cap, write-fails-drop-the-client)
 * without touching the bus or its closed, published event-type enum.
 *
 * **Two of that hub's features are deliberately absent: the replay ring buffer and
 * `Last-Event-ID` resumption.** Replaying a stale weight to a reconnecting client is worse than
 * sending nothing — a scale's value is only meaningful now — so frames carry no `id:` line and a
 * reconnecting client starts from the next live sample.
 *
 * **Phase 1 polls.** Home Assistant's WebSocket `subscribe_trigger` is the better upstream and is
 * phase 2 of the issue; it needs a hand-rolled WebSocket client (this bridge carries zero
 * dependencies), which is a comparable piece of work in its own right. Nothing here or in the PWA
 * depends on how a sample arrives, so that swap is invisible above this seam.
 *
 * The upstream is polled **once per entity, not once per client**: several clients watching the
 * same scale share one poll loop, and the loop is chained with `setTimeout` rather than
 * `setInterval` so a slow Home Assistant delays the next sample instead of stacking requests. That
 * is also the coalescing the issue asks for — intermediate samples during a settle are never
 * queued, only the newest reading is ever written.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HaError } from './client.ts';
import type { ScaleReadingDto, ScaleReadingOutcome } from './scale.ts';
import { sendError } from '../api/respond.ts';

/**
 * How often each watched entity is re-read, in milliseconds.
 *
 * A single-entity read is `GET /api/states/<entity_id>`, which is cheap — unlike the picker's
 * list-states read, which makes Home Assistant serve its entire state list. Four reads a second,
 * only while a weigh-count dialog is open with a scale selected, is the cadence a settling
 * reading needs to look live without being a load.
 */
export const DEFAULT_SCALE_POLL_MS = 250;

/**
 * Cap on concurrent scale streams, across every entity. Much smaller than the event hub's cap:
 * a scale stream exists only for as long as one dialog is open, so a double-figure count already
 * means something has leaked.
 */
export const DEFAULT_MAX_SCALE_STREAM_CLIENTS = 10;

/**
 * Heartbeat interval (ms) — a comment frame that keeps intermediaries from idling the stream out.
 *
 * Mostly redundant while the poll loop is healthy (it writes a frame every {@link
 * DEFAULT_SCALE_POLL_MS}), which is exactly why it is kept: it is the *unhealthy* case — a Home
 * Assistant that has stopped answering, so the loop is sitting in a request timeout — that a
 * proxy would otherwise close underneath the client.
 */
export const DEFAULT_SCALE_HEARTBEAT_MS = 25_000;

/**
 * The stream's media type. Exported so a `HEAD` probe of the path can report the same type a
 * `GET` would without opening a stream (which would take a client slot) — the same treatment
 * `EVENT_STREAM_CONTENT_TYPE` gets for `/api/v1/events`.
 */
export const SCALE_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/**
 * Why a live sample carried no reading.
 *
 * The first two mirror {@link ScaleReadingOutcome}'s readable-scale failures; the rest describe
 * the bridge's own conversation with Home Assistant, which the one-shot endpoint reports as an
 * HTTP status instead. `gone` is the entity disappearing mid-stream (renamed, removed, or no
 * longer a weight sensor) — it ends the stream, because there is nothing left to watch.
 */
export type ScaleStreamIssue =
  | 'unavailable'
  | 'not-a-number'
  | 'home-assistant-unreachable'
  | 'home-assistant-unauthorised'
  | 'home-assistant-error'
  | 'gone';

/** One sample, as written into a `data:` line: a reading, or the reason there isn't one. */
export type ScaleStreamFrame =
  | { readonly ok: true; readonly reading: ScaleReadingDto }
  | { readonly ok: false; readonly issue: ScaleStreamIssue };

/** The hub, mirroring `SseHub`'s surface minus the sink half (nothing is pushed into this one). */
export interface ScaleStreamHub {
  /** Handle a `GET /api/v1/scale/stream` connection: stream samples until the client disconnects. */
  handleConnection(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** Number of currently-connected clients, across every entity (tests / diagnostics). */
  clientCount(): number;
  /** Close every open stream and stop every poll loop (graceful shutdown). */
  close(): void;
}

export interface ScaleStreamOptions {
  /** The upstream read — the same `readScale` the one-shot endpoint calls. */
  readonly readScale: (entityId: string) => Promise<ScaleReadingOutcome>;
  readonly pollMs?: number;
  readonly maxClients?: number;
  readonly heartbeatMs?: number;
}

/** One entity's shared poll loop and the clients watching it. */
interface Watch {
  readonly clients: Set<ServerResponse>;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/**
 * A sample plus whether it is the last one: a terminal sample is written and then the stream
 * ends, because repeating it every 250ms would say nothing new and would keep hammering an
 * upstream that has already given a settled answer.
 */
interface Sample {
  readonly frame: ScaleStreamFrame;
  readonly terminal: boolean;
  /** Set when the upstream *transport* failed, so a connect-time gate can answer it as HTTP. */
  readonly error?: HaError;
}

/** Create the scale-stream hub. Holds no state beyond its live watches. */
export function createScaleStreamHub(options: ScaleStreamOptions): ScaleStreamHub {
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_SCALE_POLL_MS);
  const maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_SCALE_STREAM_CLIENTS);
  const heartbeatMs = Math.max(0, options.heartbeatMs ?? DEFAULT_SCALE_HEARTBEAT_MS);

  const watches = new Map<string, Watch>();
  let clients = 0;
  let heartbeat: NodeJS.Timeout | null = null;

  function startHeartbeat(): void {
    if (heartbeat !== null || heartbeatMs === 0) return;
    heartbeat = setInterval(() => {
      for (const watch of watches.values()) {
        for (const res of watch.clients) safeWrite(res, ': heartbeat\n\n');
      }
    }, heartbeatMs);
    // Don't let the heartbeat timer keep the process alive on its own.
    heartbeat.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  /** Read one sample from Home Assistant, classified into a frame the wire can carry. */
  async function sample(entityId: string): Promise<Sample> {
    let outcome: ScaleReadingOutcome;
    try {
      outcome = await options.readScale(entityId);
    } catch (err) {
      if (err instanceof HaError) {
        // A rejected token or a vanished entity will be rejected identically in 250ms, so the
        // stream ends rather than re-asking. Everything else — an unreachable instance, a 5xx —
        // is exactly the transient case a live watch should ride out, so it reports and continues.
        if (err.status === 404) return { frame: gone(), terminal: true, error: err };
        if (err.code === 'home_assistant_unauthorised') {
          return { frame: { ok: false, issue: 'home-assistant-unauthorised' }, terminal: true, error: err };
        }
        if (err.code === 'home_assistant_unreachable') {
          return { frame: { ok: false, issue: 'home-assistant-unreachable' }, terminal: false, error: err };
        }
        return { frame: { ok: false, issue: 'home-assistant-error' }, terminal: false, error: err };
      }
      // Something the client contract does not describe. Ending the stream is the honest answer:
      // we do not know what is wrong, so we must not imply the next sample will be better. It is
      // reported as an `HaError` rather than a bare frame so the connect-time gate answers it as
      // HTTP too — without that, an unexpected first read would open a stream and then poll on
      // regardless, which is exactly what this branch exists to refuse. The original error is
      // swallowed rather than forwarded: it can name the Home Assistant URL.
      return {
        frame: { ok: false, issue: 'home-assistant-error' },
        terminal: true,
        error: new HaError(502, 'home_assistant_error', 'Home Assistant returned an error.'),
      };
    }

    if (outcome.ok) return { frame: { ok: true, reading: outcome.reading }, terminal: false };
    // The client already maps `not-a-scale` to a thrown 404; handling it here too keeps issue
    // #179's guarantee (a non-scale entity is indistinguishable from a missing one) even if a
    // client returns it inline.
    if (outcome.issue === 'not-a-scale') return { frame: gone(), terminal: true };
    return { frame: { ok: false, issue: outcome.issue }, terminal: false };
  }

  function drop(entityId: string, watch: Watch, res: ServerResponse): void {
    if (!watch.clients.delete(res)) return;
    clients -= 1;
    if (watch.clients.size > 0) return;
    // The last watcher of this entity has gone, so the poll loop has nobody to serve. This is the
    // per-dialog lifetime the issue asks for: nothing keeps reading the user's scale once nobody
    // is looking at it.
    stopWatch(watch);
    watches.delete(entityId);
    if (clients === 0) stopHeartbeat();
  }

  function stopWatch(watch: Watch): void {
    watch.stopped = true;
    if (watch.timer !== null) {
      clearTimeout(watch.timer);
      watch.timer = null;
    }
  }

  /** Write one sample to every client on this watch, ending them all when it is the last. */
  function broadcast(entityId: string, watch: Watch, next: Sample): void {
    const frame = `data: ${JSON.stringify(next.frame)}\n\n`;
    for (const res of watch.clients) safeWrite(res, frame);
    if (!next.terminal) return;
    stopWatch(watch);
    watches.delete(entityId);
    for (const res of [...watch.clients]) {
      clients -= 1;
      watch.clients.delete(res);
      endStream(res);
    }
    if (clients === 0) stopHeartbeat();
  }

  /**
   * Schedule the next poll. Chained rather than an interval so a Home Assistant that takes longer
   * than `pollMs` to answer delays the following read instead of queuing another one behind it.
   */
  function schedule(entityId: string, watch: Watch): void {
    if (watch.stopped) return;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void (async () => {
        if (watch.stopped) return;
        const next = await sample(entityId);
        // The watch can be torn down while the read is in flight (the last client disconnected,
        // or `close()` ran), and writing to a response that has already ended is pointless.
        if (watch.stopped) return;
        broadcast(entityId, watch, next);
        schedule(entityId, watch);
      })();
    }, pollMs);
    watch.timer.unref?.();
  }

  return {
    async handleConnection(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const entityId = (url.searchParams.get('entity_id') ?? '').trim();
      if (entityId === '') {
        return void sendError(res, 400, 'bad_request', 'entity_id is required', { v1: true });
      }
      if (clients >= maxClients) {
        return void sendError(res, 429, 'too_many_requests', 'Too many concurrent scale streams', {
          v1: true,
          headers: { 'retry-after': '30' },
        });
      }

      // **The slot is reserved here, before the gate read below, not after it.** The check above
      // and the registration below are separated by an `await`, so counting only at registration
      // would let every connection that arrived during one Home Assistant round-trip pass a cap
      // that none of them had yet consumed — several tabs reconnecting after a bridge restart is
      // enough. `release` gives the reservation back on every path that does not open a stream.
      clients += 1;
      let reserved = true;
      const release = (): void => {
        if (!reserved) return;
        reserved = false;
        clients -= 1;
        if (clients === 0) stopHeartbeat();
      };

      // **Watch for the client leaving from here, likewise before the await.** A `close` listener
      // attached to a response whose socket has *already* gone never fires, and writes to it
      // silently no-op — so a client that disconnects during the gate read would otherwise be
      // registered, counted and polled for, with nothing left to ever remove it. (The event hub
      // has no such window: it is entirely synchronous. This `await` is what opens one.)
      let lost = res.destroyed;
      const noteLost = (): void => {
        lost = true;
      };
      res.on('close', noteLost);
      res.on('error', noteLost);

      // Gate on one real read *before* any headers go out, so the stream's contract matches the
      // one-shot endpoint's exactly: a non-scale (or missing) entity is a plain `404` revealing
      // nothing about it (issue #179), and a transport failure is the same `502` with the same
      // error code. Only once a genuine, readable scale is confirmed is the stream opened — a
      // scale that is merely switched off is *not* a transport failure, so it opens and reports.
      const first = await sample(entityId);
      if (lost || res.destroyed) {
        // Nobody is waiting for this any more; opening a stream would poll for a dead socket.
        return void release();
      }
      if (first.error !== undefined) {
        const { error } = first;
        release();
        return void sendError(res, error.status, error.code, error.message, { v1: true });
      }
      if (first.frame.ok === false && first.frame.issue === 'gone') {
        release();
        return void sendError(res, 404, 'not_found', 'No such entity.', { v1: true });
      }
      // Every terminal sample carries either an `HaError` or `gone`, both answered above, so this
      // cannot be reached — but a stream opened on a sample that has already said "there will be
      // no better one" would poll for ever, so the invariant is enforced rather than assumed.
      if (first.terminal) {
        release();
        return void sendError(res, 502, 'home_assistant_error', 'Home Assistant returned an error.', {
          v1: true,
        });
      }

      res.writeHead(200, {
        'content-type': SCALE_STREAM_CONTENT_TYPE,
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Ask reverse proxies (nginx) not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      // A stream whose upstream has gone quiet must not be closed by an idle-socket timeout.
      req.socket.setTimeout(0);

      let watch = watches.get(entityId);
      const fresh = watch === undefined;
      if (watch === undefined) {
        watch = { clients: new Set<ServerResponse>(), timer: null, stopped: false };
        watches.set(entityId, watch);
      }
      const joined = watch;
      joined.clients.add(res);
      // The reservation is now the watch's to give back, not this handler's — `drop` does the
      // decrementing from here on, so `release` must not also do it.
      reserved = false;
      startHeartbeat();
      const leave = (): void => drop(entityId, joined, res);
      res.on('close', leave);
      res.on('error', leave);

      // No `retry:` line and no replay: an `EventSource` reconnect should resume from the *next*
      // live sample, never from a weight that was true a moment ago.
      safeWrite(res, ': connected\n\n');
      safeWrite(res, `data: ${JSON.stringify(first.frame)}\n\n`);
      // The gate read is this client's first sample, so a joiner never waits a poll interval for
      // one — and an entity someone else is already watching is not re-polled on their account.
      if (fresh) schedule(entityId, joined);
    },

    clientCount: () => clients,

    close(): void {
      stopHeartbeat();
      for (const watch of watches.values()) {
        stopWatch(watch);
        for (const res of watch.clients) endStream(res);
        watch.clients.clear();
      }
      watches.clear();
      clients = 0;
    },
  };
}

/** The frame for an entity that has stopped being a readable scale. */
function gone(): ScaleStreamFrame {
  return { ok: false, issue: 'gone' };
}

/** Write to a client, dropping it silently if the socket has gone away. */
function safeWrite(res: ServerResponse, chunk: string): void {
  try {
    res.write(chunk);
  } catch {
    // A failed write means the socket is dead; the 'close'/'error' handler removes it.
  }
}

/** End a stream, tolerating a socket that has already gone. */
function endStream(res: ServerResponse): void {
  try {
    res.end();
  } catch {
    // The socket is going away regardless.
  }
}
