/**
 * Read-only Server-Sent Events stream (EI-1) — `GET /api/v1/events`.
 *
 * The pull-side twin of the webhooks: the bridge holds the connection open and writes each
 * event as a `data: <json>\n\n` frame (with an `id:` for `Last-Event-ID` resumption), so a
 * dashboard, a `curl -N`, or an agent can *watch* the inventory instead of polling. The type
 * is carried inside the JSON payload (not an SSE `event:` line), so a plain `EventSource`
 * `onmessage` handler receives every event.
 *
 * Auth and the per-IP rate limit are applied by `server.ts` before this handler runs — the
 * same bearer token as every other endpoint. The stream is strictly read-only.
 *
 * Zero dependencies: raw `node:http` writes. The hub is also an {@link EventSink}, fed by the
 * event pipeline, so the same events reach webhooks and SSE from one source.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeEvent } from './model.ts';
import type { EventSink } from './pipeline.ts';

/** Default cap on concurrent SSE clients — a backstop against a leak or an abusive client. */
export const DEFAULT_MAX_SSE_CLIENTS = 50;
/** Default heartbeat interval (ms) — a comment frame that keeps intermediaries from idling out. */
export const DEFAULT_HEARTBEAT_MS = 25_000;
/** Default size of the replay ring buffer used for `Last-Event-ID` resumption. */
export const DEFAULT_REPLAY_BUFFER = 200;
/**
 * The stream's media type. Exported because `server.ts` answers a `HEAD` probe of this path itself
 * — opening a stream for a probe would leak a client — and must report the same type a GET would
 * (issue #360), so the value lives in one place.
 */
export const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

export interface SseHubOptions {
  readonly maxClients?: number;
  readonly heartbeatMs?: number;
  readonly replayBuffer?: number;
}

export interface SseHub extends EventSink {
  /** Handle a `GET /api/v1/events` connection: stream events until the client disconnects. */
  handleConnection(req: IncomingMessage, res: ServerResponse, url: URL): void;
  /** Number of currently-connected clients (tests / diagnostics). */
  clientCount(): number;
  /** Close every open stream and stop the heartbeat (graceful shutdown). */
  close(): void;
}

/** Create the SSE hub — an event sink that also serves the live stream. */
export function createSseHub(options: SseHubOptions = {}): SseHub {
  const maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_SSE_CLIENTS);
  const heartbeatMs = Math.max(0, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const bufferSize = Math.max(0, options.replayBuffer ?? DEFAULT_REPLAY_BUFFER);

  const clients = new Set<ServerResponse>();
  const recent: BridgeEvent[] = [];
  let heartbeat: NodeJS.Timeout | null = null;

  function startHeartbeat(): void {
    if (heartbeat !== null || heartbeatMs === 0) return;
    heartbeat = setInterval(() => {
      for (const res of clients) safeWrite(res, ': heartbeat\n\n');
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

  function remove(res: ServerResponse): void {
    if (clients.delete(res) && clients.size === 0) stopHeartbeat();
  }

  return {
    deliver(events: readonly BridgeEvent[]): void {
      for (const event of events) {
        recent.push(event);
        if (recent.length > bufferSize) recent.splice(0, recent.length - bufferSize);
        const frame = frameFor(event);
        for (const res of clients) safeWrite(res, frame);
      }
    },

    handleConnection(req: IncomingMessage, res: ServerResponse, url: URL): void {
      if (clients.size >= maxClients) {
        res.writeHead(429, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': '30',
        });
        res.end(
          JSON.stringify({
            error: { code: 'too_many_requests', message: 'Too many concurrent event streams' },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'content-type': EVENT_STREAM_CONTENT_TYPE,
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Ask reverse proxies (nginx) not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      // A quiet stream must not be closed by an idle-socket timeout.
      req.socket.setTimeout(0);

      clients.add(res);
      startHeartbeat();
      const drop = (): void => remove(res);
      res.on('close', drop);
      res.on('error', drop);

      // Open the stream and suggest a reconnect delay, then replay anything missed.
      safeWrite(res, 'retry: 3000\n: connected\n\n');
      for (const event of missedSince(recent, lastEventId(req, url))) safeWrite(res, frameFor(event));
    },

    clientCount: () => clients.size,

    close(): void {
      stopHeartbeat();
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // The socket is going away regardless.
        }
      }
      clients.clear();
    },
  };
}

/** The SSE wire frame for one event: an `id:` line then a single-line JSON `data:` payload. */
function frameFor(event: BridgeEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The client's last-seen event id, from the `Last-Event-ID` header or a `?lastEventId=` param. */
function lastEventId(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['last-event-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return url.searchParams.get('lastEventId');
}

/**
 * The buffered events strictly after `lastId` (for resumption). When `lastId` is null or not in
 * the buffer (already evicted), replays nothing — safer than re-sending the whole buffer and
 * risking duplicates the consumer can't dedupe.
 */
function missedSince(buffer: readonly BridgeEvent[], lastId: string | null): readonly BridgeEvent[] {
  if (lastId === null) return [];
  const index = buffer.findIndex((e) => e.id === lastId);
  return index === -1 ? [] : buffer.slice(index + 1);
}

/** Write to a client, dropping it silently if the socket has gone away. */
function safeWrite(res: ServerResponse, chunk: string): void {
  try {
    res.write(chunk);
  } catch {
    // A failed write means the socket is dead; the 'close'/'error' handler removes it.
  }
}
