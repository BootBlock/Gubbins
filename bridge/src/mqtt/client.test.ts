/**
 * MQTT client lifecycle tests (EI-5) — the connection shell driven through an INJECTED fake socket
 * and fake timers, so the CONNECT/CONNACK/publish/reconnect/keep-alive behaviour is exercised with
 * no live broker.
 */
import { describe, expect, it, vi } from 'vitest';
import { PACKET_TYPE } from './packet.ts';
import { createMqttClient, parseMqttEndpoint, type MqttEndpoint, type RawSocket } from './client.ts';

/** A controllable fake socket that records writes and lets the test drive the lifecycle. */
class FakeSocket implements RawSocket {
  writes: Buffer[] = [];
  destroyed = false;
  private readyCb?: () => void;
  private dataCb?: (chunk: Buffer) => void;
  private closeCb?: () => void;
  private errorCb?: (err: Error) => void;

  write(data: Buffer): void {
    this.writes.push(data);
  }
  destroy(): void {
    this.destroyed = true;
    this.closeCb?.();
  }
  onReady(cb: () => void): void {
    this.readyCb = cb;
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  // --- test drivers ---
  ready(): void {
    this.readyCb?.();
  }
  emit(chunk: Buffer): void {
    this.dataCb?.(chunk);
  }
  close(): void {
    this.closeCb?.();
  }
  fail(err: Error): void {
    this.errorCb?.(err);
  }
  packetType(index: number): number {
    return this.writes[index]![0]! >> 4;
  }
}

const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const CONNACK_REFUSED = Buffer.from([0x20, 0x02, 0x00, 0x05]);

/** A test harness: a client wired to a fresh FakeSocket per connect attempt + manual timers. */
function harness(overrides: Partial<Parameters<typeof createMqttClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ cb: () => void; unref: () => void }> = [];
  const silent = { log: vi.fn(), warn: vi.fn() };
  const onConnect = vi.fn();
  const endpoint: MqttEndpoint = { host: 'broker.test', port: 1883, tls: false };
  const client = createMqttClient({
    endpoint,
    clientId: 'gubbins-bridge',
    onConnect,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: (cb) => {
      const handle = { cb, unref: () => {} };
      timers.push(handle);
      return handle;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as { cb: () => void; unref: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
    logger: silent,
    ...overrides,
  });
  const fireTimers = (): void => {
    const pending = timers.splice(0, timers.length);
    for (const t of pending) t.cb();
  };
  return { client, sockets, fireTimers, onConnect, silent, last: () => sockets[sockets.length - 1]! };
}

describe('parseMqttEndpoint', () => {
  it('defaults the port per scheme', () => {
    expect(parseMqttEndpoint('mqtt://broker.test')).toEqual({ host: 'broker.test', port: 1883, tls: false });
    expect(parseMqttEndpoint('mqtts://broker.test')).toEqual({ host: 'broker.test', port: 8883, tls: true });
  });
  it('honours an explicit port', () => {
    expect(parseMqttEndpoint('mqtt://broker.test:18830').port).toBe(18830);
  });
  it('ignores any credentials embedded in the URL', () => {
    // Credentials belong in the dedicated env vars, never a logged URL.
    expect(parseMqttEndpoint('mqtt://user:pass@broker.test:1883')).toEqual({
      host: 'broker.test',
      port: 1883,
      tls: false,
    });
  });
  it('rejects a non-mqtt scheme and a bad port', () => {
    expect(() => parseMqttEndpoint('http://broker.test')).toThrow();
    expect(() => parseMqttEndpoint('not a url')).toThrow();
    expect(() => parseMqttEndpoint('mqtt://broker.test:99999')).toThrow();
  });
});

describe('connection lifecycle', () => {
  it('sends CONNECT on transport ready and marks connected on CONNACK-accepted', () => {
    const h = harness();
    h.client.start();
    expect(h.client.isConnected()).toBe(false);
    h.last().ready();
    expect(h.last().packetType(0)).toBe(PACKET_TYPE.CONNECT);
    h.last().emit(CONNACK_OK);
    expect(h.client.isConnected()).toBe(true);
    expect(h.onConnect).toHaveBeenCalledTimes(1);
  });

  it('carries the will topic in the CONNECT when configured', () => {
    const h = harness({ will: { topic: 'gubbins/status', payload: 'offline', retain: true } });
    h.client.start();
    h.last().ready();
    expect(h.last().writes[0]!.toString('utf8')).toContain('gubbins/status');
  });

  it('publishes immediately when connected and buffers when offline', () => {
    const h = harness();
    h.client.start();
    // Offline: buffered, not written yet.
    expect(h.client.publish('gubbins/summary/state', '{}', true)).toBe(false);
    h.last().ready();
    h.last().emit(CONNACK_OK);
    // The buffered publish flushed on connect (after the CONNECT packet at index 0).
    const publishes = h.last().writes.filter((w) => w[0]! >> 4 === PACKET_TYPE.PUBLISH);
    expect(publishes).toHaveLength(1);
    // A subsequent publish goes out immediately.
    expect(h.client.publish('gubbins/event/x', '{}', false)).toBe(true);
  });

  it('drops a non-retained publish while offline (no stale event replay on reconnect)', () => {
    const h = harness();
    h.client.start();
    // Offline transient event: dropped, not buffered.
    expect(h.client.publish('gubbins/event/x', '{}', false)).toBe(false);
    h.last().ready();
    h.last().emit(CONNACK_OK);
    // Nothing flushed on connect (only the CONNECT packet went out).
    const publishes = h.last().writes.filter((w) => w[0]! >> 4 === PACKET_TYPE.PUBLISH);
    expect(publishes).toHaveLength(0);
  });

  it('force-reconnects when keep-alive pings go unanswered (half-open detection)', () => {
    const h = harness({ keepAliveSeconds: 60 });
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_OK);
    const before = h.sockets.length;
    // Fire the keep-alive repeatedly with NO inbound response: two pings then a forced reconnect,
    // then the scheduled reconnect timer creates a fresh socket.
    for (let i = 0; i < 4; i++) h.fireTimers();
    expect(h.client.isConnected()).toBe(false);
    expect(h.sockets.length).toBeGreaterThan(before);
  });

  it('reconnects (new socket) after a CONNACK refusal', () => {
    const h = harness();
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_REFUSED);
    expect(h.client.isConnected()).toBe(false);
    expect(h.last().destroyed).toBe(true);
    const before = h.sockets.length;
    h.fireTimers(); // fire the scheduled reconnect
    expect(h.sockets.length).toBe(before + 1);
  });

  it('reconnects after the socket drops post-connect', () => {
    const h = harness();
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_OK);
    const before = h.sockets.length;
    h.last().close(); // broker dropped us
    expect(h.client.isConnected()).toBe(false);
    h.fireTimers();
    expect(h.sockets.length).toBe(before + 1);
  });

  it('sends DISCONNECT and stops reconnecting on stop()', () => {
    const h = harness();
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_OK);
    h.client.stop();
    expect(h.last().packetType(h.last().writes.length - 1)).toBe(PACKET_TYPE.DISCONNECT);
    // A drop after stop must NOT schedule a reconnect.
    const before = h.sockets.length;
    h.fireTimers();
    expect(h.sockets.length).toBe(before);
  });

  it('sends a PINGREQ when the keep-alive timer fires while connected', () => {
    const h = harness({ keepAliveSeconds: 60 });
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_OK);
    const before = h.last().writes.length;
    h.fireTimers(); // the keep-alive timer
    const last = h.last().writes[h.last().writes.length - 1]!;
    expect(h.last().writes.length).toBe(before + 1);
    expect(last[0]! >> 4).toBe(PACKET_TYPE.PINGREQ);
  });

  it('frames a CONNACK that arrives split across two chunks', () => {
    const h = harness();
    h.client.start();
    h.last().ready();
    h.last().emit(CONNACK_OK.subarray(0, 2));
    expect(h.client.isConnected()).toBe(false);
    h.last().emit(CONNACK_OK.subarray(2));
    expect(h.client.isConnected()).toBe(true);
  });
});
