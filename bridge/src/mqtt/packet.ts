/**
 * Hand-rolled MQTT 3.1.1 control-packet codec (EI-5) — the **publish-only** subset.
 *
 * ## Why hand-rolled (the decision-at-entry)
 *
 * Invariant #5 nominates MQTT as the one place to reconsider the bridge's zero-runtime-dependency
 * rule. We reconsidered and kept it. The `mqtt` npm package is MIT-licensed, well-maintained and
 * popular — it would pass IP-hygiene vetting — but it exists to be a *full* client (subscribe, QoS
 * 1/2 ack state machines, WebSocket transport, reconnect policies) and pulls a broad transitive
 * tree for a job the bridge does not need. What the bridge needs is a strict, RFC-specified subset:
 * CONNECT (clean session, keep-alive, LWT/will, optional username/password), CONNACK (return code),
 * PUBLISH at **QoS 0** (no packet identifier, no acknowledgement round-trip), PINGREQ/PINGRESP
 * (keep-alive), and DISCONNECT. Publish-only means no SUBSCRIBE, no inbound PUBLISH, and no QoS-1/2
 * state — the same small surface we already hand-rolled for the mDNS wire format, JSON-RPC and the
 * iCal/YAML emitters. So we hand-roll and stay build-free and dependency-free.
 *
 * This module is **pure**: it only encodes/decodes `Buffer`s (no sockets, no clock, no I/O), so
 * every wire-format rule unit-tests directly. The impure connection lifecycle lives in `client.ts`.
 *
 * MQTT 3.1.1 spec (OASIS): control-packet types §2, CONNECT §3.1, CONNACK §3.2, PUBLISH §3.3,
 * PINGREQ §3.12, DISCONNECT §3.14, remaining-length §2.2.3, UTF-8 strings §1.5.3.
 */

/** The MQTT control-packet type nibbles this codec touches (the publish-only subset). */
export const PACKET_TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

/** Options for the CONNECT packet. Username/password/will are all optional. */
export interface ConnectOptions {
  /** Client identifier (1–23 chars is universally safe; brokers may allow more). */
  readonly clientId: string;
  /** Keep-alive interval in seconds (0 disables it). */
  readonly keepAliveSeconds: number;
  /** Optional username (MQTT §3.1.3.4). */
  readonly username?: string;
  /** Optional password (MQTT §3.1.3.5). Never logged. */
  readonly password?: string;
  /**
   * Optional Last-Will-and-Testament the broker publishes if we disconnect ungracefully — the
   * availability topic goes `offline` automatically when the bridge dies.
   */
  readonly will?: {
    readonly topic: string;
    readonly payload: string;
    readonly retain: boolean;
  };
}

/** A decoded CONNACK: whether the broker accepted the connection and its raw return code. */
export interface ConnackResult {
  readonly accepted: boolean;
  readonly returnCode: number;
  readonly sessionPresent: boolean;
}

/** Human-readable CONNACK return-code reasons (MQTT §3.2.2.3), for a secret-free log line. */
export const CONNACK_REASONS: Record<number, string> = {
  0: 'Connection accepted',
  1: 'Unacceptable protocol version',
  2: 'Identifier rejected',
  3: 'Server unavailable',
  4: 'Bad username or password',
  5: 'Not authorised',
};

/** Encode a two-byte-length-prefixed UTF-8 string (MQTT §1.5.3). */
function encodeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  if (body.length > 0xffff) {
    throw new Error(`MQTT string too long (${body.length} bytes; max 65535).`);
  }
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Encode a "remaining length" as MQTT's variable-length integer (MQTT §2.2.3): 7 bits per byte,
 * high bit is the continuation flag, up to four bytes (max 268 435 455).
 */
export function encodeRemainingLength(length: number): Buffer {
  if (length < 0 || length > 268_435_455) {
    throw new Error(`MQTT remaining length out of range: ${length}.`);
  }
  const bytes: number[] = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

/**
 * Decode a remaining-length varint starting at `offset`. Returns the value and the offset just
 * past it, or `null` when the buffer does not yet hold the whole varint (needs more bytes).
 */
export function decodeRemainingLength(
  buffer: Buffer,
  offset: number,
): { value: number; next: number } | null {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  for (let i = 0; i < 4; i++) {
    if (index >= buffer.length) return null; // incomplete — await more bytes
    const byte = buffer[index]!;
    index += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: index };
    multiplier *= 128;
  }
  throw new Error('Malformed MQTT remaining length (more than four bytes).');
}

/** Prepend the fixed header (type nibble + flags + remaining length) to a variable body. */
function withFixedHeader(type: number, flags: number, body: Buffer): Buffer {
  const first = Buffer.from([(type << 4) | (flags & 0x0f)]);
  return Buffer.concat([first, encodeRemainingLength(body.length), body]);
}

/** Encode a CONNECT packet (MQTT §3.1). Always a clean session (the bridge holds no broker state). */
export function encodeConnect(options: ConnectOptions): Buffer {
  const hasUsername = options.username !== undefined && options.username.length > 0;
  // Password is only meaningful alongside a username (MQTT §3.1.2.9).
  const hasPassword = hasUsername && options.password !== undefined && options.password.length > 0;
  const hasWill = options.will !== undefined;

  let flags = 0x02; // clean session
  if (hasWill) {
    flags |= 0x04; // will flag
    // Will QoS stays 0 (bits 4-3 clear); set the will-retain bit when requested.
    if (options.will!.retain) flags |= 0x20;
  }
  if (hasUsername) flags |= 0x80;
  if (hasPassword) flags |= 0x40;

  const keepAlive = Buffer.allocUnsafe(2);
  keepAlive.writeUInt16BE(clampKeepAlive(options.keepAliveSeconds), 0);

  const parts: Buffer[] = [
    encodeString('MQTT'), // protocol name
    Buffer.from([0x04]), // protocol level (3.1.1)
    Buffer.from([flags]), // connect flags
    keepAlive,
    encodeString(options.clientId), // payload: client id
  ];
  if (hasWill) {
    parts.push(encodeString(options.will!.topic));
    parts.push(encodeString(options.will!.payload));
  }
  if (hasUsername) parts.push(encodeString(options.username!));
  if (hasPassword) parts.push(encodeString(options.password!));

  return withFixedHeader(PACKET_TYPE.CONNECT, 0, Buffer.concat(parts));
}

/** Keep-alive is a 16-bit seconds field; clamp to a sane non-negative integer. */
function clampKeepAlive(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(0xffff, Math.floor(seconds));
}

/** Encode a QoS-0 PUBLISH (MQTT §3.3): topic + raw payload, no packet identifier. */
export function encodePublish(topic: string, payload: string | Buffer, retain = false): Buffer {
  const body = Buffer.concat([
    encodeString(topic),
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload,
  ]);
  const flags = retain ? 0x01 : 0x00; // DUP=0, QoS=0, RETAIN=retain
  return withFixedHeader(PACKET_TYPE.PUBLISH, flags, body);
}

/** Encode a PINGREQ (MQTT §3.12) — a fixed two-byte packet. */
export function encodePingReq(): Buffer {
  return Buffer.from([PACKET_TYPE.PINGREQ << 4, 0x00]);
}

/** Encode a DISCONNECT (MQTT §3.14) — a graceful, will-suppressing close. */
export function encodeDisconnect(): Buffer {
  return Buffer.from([PACKET_TYPE.DISCONNECT << 4, 0x00]);
}

/** Parse a CONNACK's two-byte variable header (MQTT §3.2). */
export function decodeConnack(variableHeader: Buffer): ConnackResult {
  if (variableHeader.length < 2) {
    throw new Error('Malformed CONNACK (fewer than two bytes).');
  }
  const returnCode = variableHeader[1]!;
  return {
    accepted: returnCode === 0,
    returnCode,
    sessionPresent: (variableHeader[0]! & 0x01) === 1,
  };
}

/** One fully-framed inbound control packet extracted from a byte stream. */
export interface IncomingPacket {
  readonly type: number;
  readonly flags: number;
  /** The variable header + payload bytes (everything after the remaining-length field). */
  readonly body: Buffer;
}

/**
 * Pull as many complete control packets as are fully present at the front of `buffer`, returning
 * them plus the unconsumed remainder (a partial packet awaiting more bytes). Publish-only clients
 * only ever receive CONNACK and PINGRESP, but this framing is generic so an unexpected packet is
 * surfaced (and ignored by the caller) rather than desynchronising the stream.
 */
export function parsePackets(buffer: Buffer): { packets: IncomingPacket[]; rest: Buffer } {
  const packets: IncomingPacket[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const first = buffer[cursor]!;
    const header = decodeRemainingLength(buffer, cursor + 1);
    if (header === null) break; // remaining-length not fully arrived yet
    const bodyStart = header.next;
    const bodyEnd = bodyStart + header.value;
    if (bodyEnd > buffer.length) break; // body not fully arrived yet
    packets.push({
      type: first >> 4,
      flags: first & 0x0f,
      body: buffer.subarray(bodyStart, bodyEnd),
    });
    cursor = bodyEnd;
  }
  return { packets, rest: buffer.subarray(cursor) };
}
