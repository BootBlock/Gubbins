/**
 * Pure mDNS / DNS-SD **discovery** — the listening half of the bridge's zeroconf support
 * (issue #126), the mirror of the advertising half in {@link ./records.ts}.
 *
 * `records.ts` builds the announcement that lets Home Assistant find *the bridge*; this module
 * reads the announcements Home Assistant itself makes, so the operator does not have to type
 * `GUBBINS_BRIDGE_HA_URL` by hand and find out it was wrong at startup.
 *
 * It is **pure and dependency-free**: it encodes one query buffer, decodes response buffers, and
 * folds them into an immutable {@link DiscoveryState}. No sockets and no I/O — those live in
 * `discover.ts` — so every fiddly bit here (compression pointers, partial responses arriving
 * across several datagrams, the URL preference order) is trivially unit-testable.
 *
 * **A discovered address is a suggestion, not a trust decision.** It only ever supplies a
 * *default* for a URL the operator left unset; an explicit `GUBBINS_BRIDGE_HA_URL` always wins,
 * the operator's own access token is still required, and the bridge's Home Assistant access stays
 * read-only regardless of how the address was found.
 */
import { decodeName, encodeName } from './records.ts';

/** The DNS-SD service type Home Assistant advertises itself under. */
export const HA_SERVICE_TYPE = '_home-assistant._tcp.local';

// DNS RR types we read back (the advertiser's private copies are in records.ts).
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

const CLASS_IN = 1;
/** Top RRCLASS bit — on a *question* this asks for a unicast response. */
const QU_BIT = 0x8000;

/** One decoded resource record, kept alongside the message it came from (names may be pointers). */
interface ParsedRecord {
  readonly name: string;
  readonly type: number;
  readonly rdataOffset: number;
  readonly rdataLength: number;
}

/** What we have learned so far about one advertised Home Assistant instance. */
export interface DiscoveredInstance {
  /** The service instance FQDN (`<name>._home-assistant._tcp.local`) — the map key. */
  readonly fqdn: string;
  /** The instance label, i.e. the FQDN's first component. */
  readonly name: string;
  /** TCP port from the SRV record, once seen. */
  readonly port: number | undefined;
  /** SRV target host (`homeassistant.local`), once seen. */
  readonly target: string | undefined;
  /** IPv4 address from the target's A record, once seen. */
  readonly address: string | undefined;
  /** TXT key/value pairs, lower-cased keys. Home Assistant puts its URLs in here. */
  readonly txt: Readonly<Record<string, string>>;
}

/** Accumulated discovery results. Immutable — {@link ingestDiscoveryMessage} returns a new one. */
export interface DiscoveryState {
  readonly instances: ReadonlyMap<string, DiscoveredInstance>;
}

/** An empty state to fold responses into. */
export function createDiscoveryState(): DiscoveryState {
  return { instances: new Map() };
}

/**
 * Encode a one-question PTR query for {@link HA_SERVICE_TYPE} — "who serves this service type?".
 * `unicastResponse` sets the QU bit, which asks responders to reply directly to our source port
 * rather than to the multicast group; it lets discovery work from an ephemeral port without
 * competing for the reserved mDNS port that the advertiser (or the host's own responder) may hold.
 */
export function encodeServiceQuery(
  serviceType: string = HA_SERVICE_TYPE,
  { unicastResponse = true }: { unicastResponse?: boolean } = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID (0 for mDNS)
  header.writeUInt16BE(0, 2); // flags: QR=0 (query)
  header.writeUInt16BE(1, 4); // QDCOUNT
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_PTR, 0);
  question.writeUInt16BE(unicastResponse ? CLASS_IN | QU_BIT : CLASS_IN, 2);
  return Buffer.concat([header, encodeName(serviceType), question]);
}

/**
 * Fold one received datagram into `state`, returning a new state. Anything unrecognised or
 * malformed is ignored — a stray datagram from an unrelated responder (mDNS is a shared bus) must
 * never throw. Records for other service types are skipped.
 *
 * Home Assistant usually sends PTR + SRV + TXT + A in a single response, but the records are
 * merged per instance so a responder that splits them across datagrams still resolves.
 */
export function ingestDiscoveryMessage(
  state: DiscoveryState,
  msg: Buffer,
  serviceType: string = HA_SERVICE_TYPE,
): DiscoveryState {
  let records: ParsedRecord[];
  try {
    records = decodeRecords(msg);
  } catch {
    return state;
  }

  const wantedType = serviceType.toLowerCase();
  const suffix = `.${wantedType}`;
  const isInstanceName = (name: string): boolean => name.toLowerCase().endsWith(suffix);

  // Pass 1: the PTR answers name the instances; SRV/TXT attach to an instance directly.
  const next = new Map(state.instances);
  const upsert = (fqdn: string, patch: Partial<DiscoveredInstance>): void => {
    const key = fqdn.toLowerCase();
    const existing = next.get(key) ?? blankInstance(fqdn);
    next.set(key, {
      ...existing,
      ...patch,
      // A later response must not blank out a field an earlier one filled in.
      port: patch.port ?? existing.port,
      target: patch.target ?? existing.target,
      address: patch.address ?? existing.address,
      txt: patch.txt ? { ...existing.txt, ...patch.txt } : existing.txt,
    });
  };

  for (const record of records) {
    if (record.type === TYPE_PTR && record.name.toLowerCase() === wantedType) {
      const fqdn = decodeName(msg, record.rdataOffset).name;
      if (isInstanceName(fqdn)) upsert(fqdn, {});
    } else if (record.type === TYPE_SRV && isInstanceName(record.name)) {
      const srv = readSrv(msg, record);
      if (srv) upsert(record.name, srv);
    } else if (record.type === TYPE_TXT && isInstanceName(record.name)) {
      upsert(record.name, { txt: readTxt(msg, record) });
    }
  }

  // Pass 2: A records key off the *host* name, so they can only be matched once the SRV targets
  // are known — including SRV records that arrived in an earlier datagram.
  for (const record of records) {
    if (record.type !== TYPE_A) continue;
    const address = readA(msg, record);
    if (address === null) continue;
    const host = record.name.toLowerCase();
    for (const [key, instance] of next) {
      if (instance.address === undefined && instance.target?.toLowerCase() === host) {
        next.set(key, { ...instance, address });
      }
    }
  }

  return { instances: next };
}

/**
 * The URL to offer for a discovered instance, or `null` when it is not resolvable yet.
 *
 * Home Assistant publishes its own configured URLs in TXT, which is the value the operator would
 * have typed, so those win. `internal_url` is preferred over `external_url` — the bridge is on the
 * same LAN, and the external URL may route out and back in (or not resolve at all from here).
 * Falling back to the SRV/A pair reconstructs `http://<address>:<port>`, which is the plain
 * unconfigured case.
 */
export function discoveredUrl(instance: DiscoveredInstance): string | null {
  for (const key of ['internal_url', 'base_url', 'external_url']) {
    const url = parseHttpUrl(instance.txt[key]);
    if (url !== null) return url;
  }
  const host = instance.address ?? instance.target ?? '';
  if (host.length === 0 || instance.port === undefined) return null;
  return `http://${host}:${instance.port}`;
}

/** A resolvable instance and the URL to use for it. */
export interface DiscoveryResult {
  readonly url: string;
  /** The advertised instance label, for the startup log line. */
  readonly name: string;
}

/**
 * The first instance in `state` that resolves to a usable URL, or `null`. Insertion order is the
 * order the responses arrived, so "first" means "answered first" — with a single Home Assistant on
 * the LAN (overwhelmingly the common case) there is only ever one candidate anyway.
 */
export function firstDiscoveryResult(state: DiscoveryState): DiscoveryResult | null {
  for (const instance of state.instances.values()) {
    const url = discoveredUrl(instance);
    if (url !== null) return { url, name: instance.name };
  }
  return null;
}

/** The decision on whether to run discovery at all, with a human reason. */
export interface HaDiscoveryPlan {
  readonly discover: boolean;
  /**
   * One of: `disabled` (not opted in), `off` (Home Assistant reads themselves are off),
   * `configured` (an explicit URL already wins), `discover`.
   */
  readonly reason: 'disabled' | 'off' | 'configured' | 'discover';
}

/**
 * Decide whether to look for Home Assistant. Three gates: the Home Assistant read path must be on
 * at all, discovery must be **opted into** (consistent with every other network-touching feature —
 * nothing listens or probes the LAN unless the operator said so), and the URL must actually be
 * unset — an explicit `GUBBINS_BRIDGE_HA_URL` always wins, so discovery is pure convenience.
 */
export function resolveHaDiscoveryPlan({
  homeAssistant,
  enabled,
  configuredUrl,
}: {
  homeAssistant: boolean;
  enabled: boolean;
  configuredUrl: string | undefined;
}): HaDiscoveryPlan {
  if (!homeAssistant) return { discover: false, reason: 'off' };
  if (!enabled) return { discover: false, reason: 'disabled' };
  if (configuredUrl !== undefined) return { discover: false, reason: 'configured' };
  return { discover: true, reason: 'discover' };
}

// ── wire-format helpers ────────────────────────────────────────────────────────────────

function blankInstance(fqdn: string): DiscoveredInstance {
  return {
    fqdn,
    name: fqdn.split('.')[0] ?? fqdn,
    port: undefined,
    target: undefined,
    address: undefined,
    txt: {},
  };
}

/**
 * Decode every resource record in a response — answer, authority *and* additional sections. The
 * SRV/TXT/A records that make a PTR answer usable normally travel in the additional section, so
 * reading only the answers would leave every instance unresolvable.
 */
function decodeRecords(msg: Buffer): ParsedRecord[] {
  if (msg.length < 12) return [];
  const qdcount = msg.readUInt16BE(4);
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);

  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const { nextOffset } = decodeName(msg, offset);
    offset = nextOffset + 4;
    if (offset > msg.length) return [];
  }

  const out: ParsedRecord[] = [];
  for (let i = 0; i < total; i++) {
    const { name, nextOffset } = decodeName(msg, offset);
    if (nextOffset + 10 > msg.length) break;
    const type = msg.readUInt16BE(nextOffset);
    const rdataLength = msg.readUInt16BE(nextOffset + 8);
    const rdataOffset = nextOffset + 10;
    if (rdataOffset + rdataLength > msg.length) break;
    out.push({ name, type, rdataOffset, rdataLength });
    offset = rdataOffset + rdataLength;
  }
  return out;
}

function readSrv(msg: Buffer, record: ParsedRecord): { port: number; target: string } | null {
  if (record.rdataLength < 7) return null;
  const port = msg.readUInt16BE(record.rdataOffset + 4);
  const target = decodeName(msg, record.rdataOffset + 6).name;
  if (target.length === 0) return null;
  return { port, target };
}

function readTxt(msg: Buffer, record: ParsedRecord): Record<string, string> {
  const out: Record<string, string> = {};
  const end = record.rdataOffset + record.rdataLength;
  let pos = record.rdataOffset;
  while (pos < end) {
    const len = msg[pos] ?? 0;
    pos += 1;
    if (len === 0 || pos + len > end) {
      if (len === 0) continue; // an empty TXT string is legal padding
      break;
    }
    const entry = msg.toString('utf8', pos, pos + len);
    pos += len;
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
  }
  return out;
}

function readA(msg: Buffer, record: ParsedRecord): string | null {
  if (record.rdataLength !== 4) return null;
  const o = record.rdataOffset;
  return `${msg[o]}.${msg[o + 1]}.${msg[o + 2]}.${msg[o + 3]}`;
}

/**
 * Parse an advertised TXT value into a usable `http(s)` base URL, or `null` if it is not one.
 * Parsing rather than pattern-matching is what rejects a truncated `http://`, which a `^https?://`
 * test would accept and a trailing-slash strip would then reduce to the nonsense base URL `http:`.
 */
function parseHttpUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;
  // `origin` normalises away a default port, a trailing slash and any path/query the operator's
  // configured URL happened to carry — the client wants a bare base URL.
  return url.origin;
}
