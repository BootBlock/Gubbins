/**
 * MQTT 3.1.1 packet-codec tests (EI-5) — the hand-rolled wire format, exercised directly. Every
 * assertion is against the byte layout the OASIS spec mandates, so a regression in the encoder is
 * caught without a live broker.
 */
import { describe, expect, it } from 'vitest';
import {
  PACKET_TYPE,
  decodeConnack,
  decodeRemainingLength,
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodePublish,
  encodeRemainingLength,
  parsePackets,
} from './packet.ts';

/** Read a two-byte-length-prefixed UTF-8 string at `offset`; returns the value and the next offset. */
function readString(buf: Buffer, offset: number): { value: string; next: number } {
  const len = buf.readUInt16BE(offset);
  return { value: buf.toString('utf8', offset + 2, offset + 2 + len), next: offset + 2 + len };
}

describe('remaining-length varint', () => {
  it('round-trips the boundary values (single- and multi-byte)', () => {
    for (const n of [0, 1, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152, 268_435_455]) {
      const encoded = encodeRemainingLength(n);
      const decoded = decodeRemainingLength(encoded, 0);
      expect(decoded).not.toBeNull();
      expect(decoded!.value).toBe(n);
      expect(decoded!.next).toBe(encoded.length);
    }
  });

  it('uses the documented byte counts', () => {
    expect(encodeRemainingLength(127)).toHaveLength(1);
    expect(encodeRemainingLength(128)).toHaveLength(2);
    expect(encodeRemainingLength(16_384)).toHaveLength(3);
    expect(encodeRemainingLength(2_097_152)).toHaveLength(4);
  });

  it('returns null when the varint is not yet fully present', () => {
    // 0x80 has the continuation bit set but no following byte.
    expect(decodeRemainingLength(Buffer.from([0x80]), 0)).toBeNull();
  });

  it('rejects an out-of-range length', () => {
    expect(() => encodeRemainingLength(268_435_456)).toThrow();
  });
});

describe('CONNECT', () => {
  it('encodes the protocol name, level, clean-session flag and client id', () => {
    const packet = encodeConnect({ clientId: 'gubbins-bridge', keepAliveSeconds: 60 });
    expect(packet[0]! >> 4).toBe(PACKET_TYPE.CONNECT);
    // After the fixed header (byte 0) + remaining length (1 byte here), the variable header starts.
    const rl = decodeRemainingLength(packet, 1)!;
    let offset = rl.next;
    const proto = readString(packet, offset);
    expect(proto.value).toBe('MQTT');
    offset = proto.next;
    expect(packet[offset]).toBe(0x04); // protocol level 3.1.1
    const flags = packet[offset + 1]!;
    expect(flags & 0x02).toBe(0x02); // clean session
    expect(flags & 0x80).toBe(0); // no username
    const keepAlive = packet.readUInt16BE(offset + 2);
    expect(keepAlive).toBe(60);
    const clientId = readString(packet, offset + 4);
    expect(clientId.value).toBe('gubbins-bridge');
  });

  it('sets the username/password flags and appends them in the payload', () => {
    const packet = encodeConnect({
      clientId: 'c',
      keepAliveSeconds: 30,
      username: 'user',
      password: 'pass',
    });
    const rl = decodeRemainingLength(packet, 1)!;
    // Variable header = MQTT string (6) + level (1); the connect-flags byte follows at +7.
    const flagsByte = packet[rl.next + 7]!;
    expect(flagsByte & 0x80).toBe(0x80); // username present
    expect(flagsByte & 0x40).toBe(0x40); // password present
    // The payload should contain the username and password strings after the client id.
    const text = packet.toString('utf8');
    expect(text).toContain('user');
    expect(text).toContain('pass');
  });

  it('sets the will flag + retain and carries the will topic/payload', () => {
    const packet = encodeConnect({
      clientId: 'c',
      keepAliveSeconds: 0,
      will: { topic: 'gubbins/status', payload: 'offline', retain: true },
    });
    const rl = decodeRemainingLength(packet, 1)!;
    const flagsByte = packet[rl.next + 7]!;
    expect(flagsByte & 0x04).toBe(0x04); // will flag
    expect(flagsByte & 0x20).toBe(0x20); // will retain
    const text = packet.toString('utf8');
    expect(text).toContain('gubbins/status');
    expect(text).toContain('offline');
  });

  it('drops a password when no username is present (MQTT §3.1.2.9)', () => {
    const packet = encodeConnect({ clientId: 'c', keepAliveSeconds: 0, password: 'orphan' });
    const rl = decodeRemainingLength(packet, 1)!;
    const flagsByte = packet[rl.next + 7]!;
    expect(flagsByte & 0x40).toBe(0); // password flag NOT set
    expect(packet.toString('utf8')).not.toContain('orphan');
  });
});

describe('PUBLISH', () => {
  it('encodes a QoS-0 publish: topic then raw payload, no packet id', () => {
    const packet = encodePublish('gubbins/summary/state', '{"itemsTotal":3}', true);
    expect(packet[0]! >> 4).toBe(PACKET_TYPE.PUBLISH);
    expect(packet[0]! & 0x01).toBe(0x01); // retain bit
    expect(packet[0]! & 0x06).toBe(0x00); // QoS 0 (no packet identifier follows)
    const rl = decodeRemainingLength(packet, 1)!;
    const topic = readString(packet, rl.next);
    expect(topic.value).toBe('gubbins/summary/state');
    const payload = packet.toString('utf8', topic.next);
    expect(payload).toBe('{"itemsTotal":3}');
  });

  it('clears the retain bit when not retained', () => {
    const packet = encodePublish('gubbins/event/item.created', '{}', false);
    expect(packet[0]! & 0x01).toBe(0);
  });

  it('handles a multi-byte UTF-8 payload length correctly', () => {
    const big = 'x'.repeat(200);
    const packet = encodePublish('t', big);
    const rl = decodeRemainingLength(packet, 1)!;
    const topic = readString(packet, rl.next);
    expect(packet.toString('utf8', topic.next)).toBe(big);
  });
});

describe('PINGREQ / DISCONNECT', () => {
  it('are the fixed two-byte packets', () => {
    expect([...encodePingReq()]).toEqual([PACKET_TYPE.PINGREQ << 4, 0x00]);
    expect([...encodeDisconnect()]).toEqual([PACKET_TYPE.DISCONNECT << 4, 0x00]);
  });
});

describe('CONNACK decode', () => {
  it('accepts return code 0 and reads the session-present flag', () => {
    expect(decodeConnack(Buffer.from([0x01, 0x00]))).toEqual({
      accepted: true,
      returnCode: 0,
      sessionPresent: true,
    });
    expect(decodeConnack(Buffer.from([0x00, 0x00])).sessionPresent).toBe(false);
  });

  it('rejects a non-zero return code', () => {
    const result = decodeConnack(Buffer.from([0x00, 0x05]));
    expect(result.accepted).toBe(false);
    expect(result.returnCode).toBe(5);
  });

  it('throws on a truncated CONNACK', () => {
    expect(() => decodeConnack(Buffer.from([0x00]))).toThrow();
  });
});

describe('parsePackets (inbound framing)', () => {
  it('extracts a CONNACK and a PINGRESP, leaving no remainder', () => {
    const connack = Buffer.from([0x20, 0x02, 0x00, 0x00]);
    const pingresp = Buffer.from([0xd0, 0x00]);
    const { packets, rest } = parsePackets(Buffer.concat([connack, pingresp]));
    expect(packets).toHaveLength(2);
    expect(packets[0]!.type).toBe(PACKET_TYPE.CONNACK);
    expect(packets[1]!.type).toBe(PACKET_TYPE.PINGRESP);
    expect(rest).toHaveLength(0);
  });

  it('holds back a partial trailing packet as the remainder', () => {
    const connack = Buffer.from([0x20, 0x02, 0x00, 0x00]);
    const partial = Buffer.from([0x20, 0x02, 0x00]); // one byte short
    const { packets, rest } = parsePackets(Buffer.concat([connack, partial]));
    expect(packets).toHaveLength(1);
    expect(rest).toEqual(partial);
  });
});
