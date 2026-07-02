/**
 * Pure mDNS / DNS-SD (RFC 6762 / 6763) record building & question parsing for the
 * bridge's optional LAN service advertisement (Deferred-work: mDNS / zeroconf discovery).
 *
 * This module is **pure and dependency-free**: it only encodes/decodes DNS wire-format
 * `Buffer`s and decides *whether* to advertise — no sockets, no `node:dgram`, no I/O. The
 * impure multicast lifecycle lives in `advertise.ts`, so all the fiddly wire-format and
 * gating logic here is trivially unit-testable.
 *
 * It lets Home Assistant **auto-discover** a LAN-exposed bridge instead of the user typing
 * host/port into the config flow. The advertisement carries only non-secret identification
 * (service type, port, and a small TXT record naming the API path/version) — **never** the
 * bearer token or any other secret. The token is still entered in HA's UI.
 *
 * Advertising is only meaningful when the bridge is deliberately LAN-exposed
 * (`GUBBINS_BRIDGE_HOST=0.0.0.0`); on the loopback default it is pointless, so
 * {@link resolveMdnsPlan} gates it off. It is also opt-in (`GUBBINS_BRIDGE_MDNS=on`).
 */
import { isLanExposed } from '../config.ts';

/** The DNS-SD service type HA matches on (a dedicated type, not the noisy `_http._tcp`). */
export const SERVICE_TYPE = '_gubbins._tcp.local';
/** Default human-readable service instance name (the bit shown in a discovery browser). */
export const DEFAULT_INSTANCE_NAME = 'Gubbins Bridge';
/** IPv4 link-local multicast group for mDNS. */
export const MDNS_MULTICAST_ADDRESS = '224.0.0.251';
/** The reserved mDNS UDP port. */
export const MDNS_PORT = 5353;
/** Record TTL (seconds) for a live advertisement. */
export const DEFAULT_TTL_SECONDS = 120;

// DNS RR types we use.
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;

// DNS classes / flags.
const CLASS_IN = 1;
/** Top RRCLASS bit: "cache-flush" on a response RR / "unicast-response wanted" on a question. */
const TOP_BIT = 0x8000;
/** Response header flags: QR=1 (response) + AA=1 (authoritative). */
const FLAGS_RESPONSE = 0x8400;

/** Non-secret TXT key/value inputs. NEVER put a token or any secret in here. */
export interface TxtParams {
  /** API version string HA can read, e.g. `v1`. */
  readonly apiVersion?: string;
  /** Base path of the versioned REST API, e.g. `/api/v1`. */
  readonly basePath?: string;
  /** The bridge package version, for diagnostics. */
  readonly serverVersion?: string;
}

/** Everything needed to build the advertisement records (pure data — no secrets). */
export interface AdvertisementParams {
  /** Service instance name; defaults to {@link DEFAULT_INSTANCE_NAME}. */
  readonly instanceName?: string;
  /** Host label for the `A`/`SRV` target, e.g. `gubbins-bridge` → `gubbins-bridge.local`. */
  readonly hostLabel: string;
  /** TCP port the HTTP server listens on. */
  readonly port: number;
  /** Advertised IPv4 address for the `A` record. */
  readonly address: string;
  /** TXT record contents (non-secret). */
  readonly txt?: TxtParams;
  /** Record TTL in seconds; defaults to {@link DEFAULT_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
}

/** A parsed DNS question (only the fields we need to decide whether to respond). */
export interface ParsedQuestion {
  readonly name: string;
  readonly type: number;
}

/**
 * Build the (non-secret) TXT record entries. Each entry is a `key=value` string; HA reads
 * these to identify the service and learn the API path/version. **No secret may ever appear
 * here** — the bearer token is entered in HA's UI, never advertised.
 */
export function buildTxtEntries(txt: TxtParams = {}): string[] {
  return [
    'server=gubbins-bridge',
    `api=${txt.apiVersion ?? 'v1'}`,
    `path=${txt.basePath ?? '/api/v1'}`,
    `version=${txt.serverVersion ?? '0.0.0'}`,
  ];
}

/** The fully-qualified service instance name (`<instance>._gubbins._tcp.local`). */
export function instanceFqdn(instanceName: string = DEFAULT_INSTANCE_NAME): string {
  return `${instanceName}.${SERVICE_TYPE}`;
}

/**
 * Encode a complete mDNS **announcement** (or **goodbye**, with `goodbye: true` → TTL 0) as
 * a DNS response message carrying the PTR + SRV + TXT + A records for the service. This is
 * sent unsolicited on start (announce) / stop (goodbye), and also as the reply to a matching
 * query.
 */
export function encodeAnnouncement(
  params: AdvertisementParams,
  { goodbye = false }: { goodbye?: boolean } = {},
): Buffer {
  const ttl = goodbye ? 0 : (params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const instance = params.instanceName ?? DEFAULT_INSTANCE_NAME;
  const target = `${params.hostLabel}.local`;
  const fqdn = instanceFqdn(instance);

  const answers = [
    // PTR is a *shared* record → no cache-flush bit.
    encodeRecord(SERVICE_TYPE, TYPE_PTR, CLASS_IN, ttl, encodeName(fqdn)),
    // SRV / TXT / A are *unique* to this instance → cache-flush bit set.
    encodeRecord(fqdn, TYPE_SRV, CLASS_IN | TOP_BIT, ttl, encodeSrvRdata(params.port, target)),
    encodeRecord(fqdn, TYPE_TXT, CLASS_IN | TOP_BIT, ttl, encodeTxtRdata(buildTxtEntries(params.txt))),
    encodeRecord(target, TYPE_A, CLASS_IN | TOP_BIT, ttl, encodeARdata(params.address)),
  ];
  return encodeMessage(answers);
}

/** Whether `msg` is a DNS *query* (QR bit clear) with at least one question. */
export function isQuery(msg: Buffer): boolean {
  if (msg.length < 12) return false;
  const flags = msg.readUInt16BE(2);
  const qdcount = msg.readUInt16BE(4);
  return (flags & TOP_BIT) === 0 && qdcount > 0;
}

/** Parse the question section of a DNS message (names support compression pointers). */
export function decodeQuestions(msg: Buffer): ParsedQuestion[] {
  const qdcount = msg.readUInt16BE(4);
  const out: ParsedQuestion[] = [];
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const { name, nextOffset } = decodeName(msg, offset);
    if (nextOffset + 4 > msg.length) break;
    const type = msg.readUInt16BE(nextOffset);
    out.push({ name, type });
    offset = nextOffset + 4;
  }
  return out;
}

/**
 * Whether any of `questions` asks for our service — a PTR/SRV/TXT/ANY query for the service
 * type or our instance name. Comparison is case-insensitive (DNS names are).
 */
export function isQueryForService(
  questions: readonly ParsedQuestion[],
  instanceName: string = DEFAULT_INSTANCE_NAME,
): boolean {
  const wanted = new Set([SERVICE_TYPE.toLowerCase(), instanceFqdn(instanceName).toLowerCase()]);
  return questions.some(
    (q) =>
      wanted.has(q.name.toLowerCase()) &&
      (q.type === TYPE_PTR || q.type === TYPE_SRV || q.type === TYPE_TXT || q.type === TYPE_ANY),
  );
}

/** The decision on whether the bridge should advertise over mDNS, with a human reason. */
export interface MdnsPlan {
  readonly advertise: boolean;
  /** One of: `disabled` (opt-out), `loopback` (pointless on a local bind), `advertise`. */
  readonly reason: 'disabled' | 'loopback' | 'advertise';
}

/**
 * Decide whether to advertise. Two gates, both must pass: it must be opt-in (`enabled`),
 * **and** the bridge must actually be LAN-exposed — advertising a loopback-only bind to the
 * LAN is pointless, so we auto-skip it even when the operator turned the flag on.
 */
export function resolveMdnsPlan({ enabled, host }: { enabled: boolean; host: string }): MdnsPlan {
  if (!enabled) return { advertise: false, reason: 'disabled' };
  if (!isLanExposed(host)) return { advertise: false, reason: 'loopback' };
  return { advertise: true, reason: 'advertise' };
}

/** Minimal shape of one `os.networkInterfaces()` entry (family/internal/address). */
export interface InterfaceAddress {
  readonly family: string | number;
  readonly internal: boolean;
  readonly address: string;
}

/**
 * Pick the IPv4 address to advertise in the `A` record. If `configHost` is already a
 * concrete (non-wildcard, non-loopback) IPv4, use it; otherwise pick the first non-internal
 * IPv4 across the host's interfaces. Returns `null` when no routable IPv4 is found.
 */
export function pickAdvertisedAddress(
  interfaces: Record<string, readonly InterfaceAddress[] | undefined>,
  configHost: string,
): string | null {
  if (isConcreteIpv4(configHost)) return configHost;
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (isIpv4(info.family) && !info.internal && isConcreteIpv4(info.address)) return info.address;
    }
  }
  return null;
}

/** Sanitise an arbitrary hostname into a single safe DNS label, with a stable fallback. */
export function sanitizeHostLabel(hostname: string): string {
  const label = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return label.length > 0 ? label : 'gubbins-bridge';
}

// ── wire-format helpers ────────────────────────────────────────────────────────────────

/** Encode a dotted DNS name (no compression — always valid for receivers). */
export function encodeName(name: string): Buffer {
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .filter((l) => l.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error(`DNS label too long: "${label}"`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeRecord(name: string, type: number, klass: number, ttl: number, rdata: Buffer): Buffer {
  const head = encodeName(name);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(klass, 2);
  meta.writeUInt32BE(ttl >>> 0, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([head, meta, rdata]);
}

function encodeSrvRdata(port: number, target: string): Buffer {
  const head = Buffer.alloc(6); // priority 0, weight 0, port
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function encodeTxtRdata(entries: readonly string[]): Buffer {
  if (entries.length === 0) return Buffer.from([0]); // an empty TXT is one zero-length string
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry, 'utf8');
    if (bytes.length > 255) throw new Error('TXT entry too long');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat(parts);
}

function encodeARdata(address: string): Buffer {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`invalid IPv4 address: "${address}"`);
  }
  return Buffer.from(octets);
}

function encodeMessage(answers: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID (0 for mDNS)
  header.writeUInt16BE(FLAGS_RESPONSE, 2);
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT
  return Buffer.concat([header, ...answers]);
}

/** Decode a DNS name starting at `offset`, following compression pointers. */
function decodeName(msg: Buffer, offset: number): { name: string; nextOffset: number } {
  const labels: string[] = [];
  let pos = offset;
  let nextOffset = offset;
  let jumped = false;
  let guard = 0;
  for (;;) {
    if (guard++ > 128 || pos >= msg.length) break; // malformed — stop defensively
    const len = msg[pos] ?? 0;
    if (len === 0) {
      if (!jumped) nextOffset = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= msg.length) break;
      if (!jumped) nextOffset = pos + 2;
      jumped = true;
      pos = ((len & 0x3f) << 8) | (msg[pos + 1] ?? 0);
      continue;
    }
    const end = pos + 1 + len;
    if (end > msg.length) break;
    labels.push(msg.toString('utf8', pos + 1, end));
    pos = end;
  }
  return { name: labels.join('.'), nextOffset };
}

function isIpv4(family: string | number): boolean {
  return family === 'IPv4' || family === 4;
}

function isConcreteIpv4(address: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  if (address === '0.0.0.0') return false;
  if (address.startsWith('127.')) return false;
  return address.split('.').every((o) => Number(o) <= 255);
}
