/**
 * SSE hub unit tests (EI-1). The hub is driven with lightweight fake req/res doubles (no real
 * socket) so the framing, resumption buffer, and client-cap logic test deterministically.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { BridgeEvent } from './model.ts';
import { createSseHub } from './sse.ts';

function event(id: string, type = 'stock.adjusted'): BridgeEvent {
  return {
    id,
    type,
    occurredAt: '2025-06-27T06:13:20.000Z',
    data: {
      itemId: 'item-1',
      itemName: 'Widget',
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: null,
      delta: null,
      quantityDelta: null,
      netValueDelta: null,
      actorUserId: 'user-ada',
      actorDisplayName: 'Ada',
      item: null,
    },
  };
}

interface FakeRes extends ServerResponse {
  readonly chunks: string[];
  statusCode: number;
  fire(eventName: string): void;
}

function fakeRes(): FakeRes {
  const chunks: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let status = 0;
  return {
    get chunks() {
      return chunks;
    },
    get statusCode() {
      return status;
    },
    set statusCode(s: number) {
      status = s;
    },
    writeHead(s: number) {
      status = s;
      return this;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      return this;
    },
    on(name: string, fn: () => void) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return this;
    },
    fire(name: string) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
  } as unknown as FakeRes;
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { setTimeout() {} } } as unknown as IncomingMessage;
}

const url = (query = ''): URL => new URL(`http://127.0.0.1/api/v1/events${query}`);

describe('createSseHub', () => {
  it('opens a stream and writes each delivered event as an id+data frame', () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const res = fakeRes();
    hub.handleConnection(fakeReq(), res, url());
    expect(res.statusCode).toBe(200);
    expect(res.chunks.join('')).toContain(': connected');

    hub.deliver([event('e1')]);
    const written = res.chunks.join('');
    expect(written).toContain('id: e1\n');
    expect(written).toContain('data: {"id":"e1"');
    expect(written.endsWith('\n\n')).toBe(true);
  });

  it('replays buffered events after the Last-Event-ID on connect, and nothing before it', () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    hub.deliver([event('e1'), event('e2'), event('e3')]); // no clients yet — just buffered

    const res = fakeRes();
    hub.handleConnection(fakeReq({ 'last-event-id': 'e1' }), res, url());
    const written = res.chunks.join('');
    expect(written).not.toContain('id: e1\n');
    expect(written).toContain('id: e2\n');
    expect(written).toContain('id: e3\n');
  });

  it('accepts the lastEventId as a query-string alias', () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    hub.deliver([event('e1'), event('e2')]);
    const res = fakeRes();
    hub.handleConnection(fakeReq(), res, url('?lastEventId=e1'));
    expect(res.chunks.join('')).toContain('id: e2\n');
  });

  it('replays nothing when the Last-Event-ID has already been evicted from the buffer', () => {
    const hub = createSseHub({ heartbeatMs: 0, replayBuffer: 2 });
    hub.deliver([event('e1'), event('e2'), event('e3')]); // e1 evicted (buffer size 2)
    const res = fakeRes();
    hub.handleConnection(fakeReq({ 'last-event-id': 'e1' }), res, url());
    const written = res.chunks.join('');
    expect(written).toContain(': connected');
    expect(written).not.toContain('id: e2\n');
    expect(written).not.toContain('id: e3\n');
  });

  it('caps concurrent clients with a 429 and does not add the rejected client', () => {
    const hub = createSseHub({ heartbeatMs: 0, maxClients: 1 });
    hub.handleConnection(fakeReq(), fakeRes(), url());
    expect(hub.clientCount()).toBe(1);

    const rejected = fakeRes();
    hub.handleConnection(fakeReq(), rejected, url());
    expect(rejected.statusCode).toBe(429);
    expect(hub.clientCount()).toBe(1);
  });

  it('drops a client when its connection closes', () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const res = fakeRes();
    hub.handleConnection(fakeReq(), res, url());
    expect(hub.clientCount()).toBe(1);
    res.fire('close');
    expect(hub.clientCount()).toBe(0);
  });
});
