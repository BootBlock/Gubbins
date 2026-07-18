/**
 * Pure mDNS discovery tests (issue #126) — query encoding, response decoding across one or several
 * datagrams, the URL preference order, and the opt-in gating. No sockets: everything here is a
 * `Buffer` in and a plain object out. All hosts/addresses are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { encodeName } from './records.ts';
import {
  createDiscoveryState,
  discoveredUrl,
  encodeServiceQuery,
  firstDiscoveryResult,
  HA_SERVICE_TYPE,
  ingestDiscoveryMessage,
  resolveHaDiscoveryPlan,
  type DiscoveredInstance,
} from './discovery.ts';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;

const INSTANCE = `Home._home-assistant._tcp.local`;

function record(name: string, type: number, rdata: Buffer): Buffer {
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(CLASS_IN, 2);
  meta.writeUInt32BE(120, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), meta, rdata]);
}

function response(answers: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // QR + AA
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  return Buffer.concat([header, ...answers]);
}

function srvRdata(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function txtRdata(entries: readonly string[]): Buffer {
  return Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([e.length]), Buffer.from(e, 'utf8')])));
}

function aRdata(address: string): Buffer {
  return Buffer.from(address.split('.').map(Number));
}

/** A complete Home Assistant announcement, as one datagram. */
function fullAnnouncement(txt: readonly string[] = []): Buffer {
  return response([
    record(HA_SERVICE_TYPE, TYPE_PTR, encodeName(INSTANCE)),
    record(INSTANCE, TYPE_SRV, srvRdata(8123, 'ha-host.local')),
    record(INSTANCE, TYPE_TXT, txtRdata(txt)),
    record('ha-host.local', TYPE_A, aRdata('192.0.2.10')),
  ]);
}

function ingest(...messages: readonly Buffer[]) {
  return messages.reduce((state, msg) => ingestDiscoveryMessage(state, msg), createDiscoveryState());
}

describe('encodeServiceQuery', () => {
  it('encodes a single PTR question for the Home Assistant service type', () => {
    const query = encodeServiceQuery();
    expect(query.readUInt16BE(2) & 0x8000).toBe(0); // QR clear → a query
    expect(query.readUInt16BE(4)).toBe(1); // one question
    const question = query.subarray(12);
    expect(question.subarray(0, encodeName(HA_SERVICE_TYPE).length)).toEqual(encodeName(HA_SERVICE_TYPE));
    expect(query.readUInt16BE(query.length - 4)).toBe(TYPE_PTR);
    expect(query.readUInt16BE(query.length - 2) & 0x8000).toBe(0x8000); // QU bit set by default
  });

  it('can ask for a multicast response instead', () => {
    const query = encodeServiceQuery(HA_SERVICE_TYPE, { unicastResponse: false });
    expect(query.readUInt16BE(query.length - 2)).toBe(CLASS_IN);
  });
});

describe('ingestDiscoveryMessage', () => {
  it('resolves an instance from a single complete announcement', () => {
    const result = firstDiscoveryResult(ingest(fullAnnouncement()));
    expect(result).toEqual({ url: 'http://192.0.2.10:8123', name: 'Home' });
  });

  it('merges records that arrive across separate datagrams', () => {
    const ptrOnly = response([record(HA_SERVICE_TYPE, TYPE_PTR, encodeName(INSTANCE))]);
    const srvOnly = response([record(INSTANCE, TYPE_SRV, srvRdata(8123, 'ha-host.local'))]);
    const aOnly = response([record('ha-host.local', TYPE_A, aRdata('192.0.2.11'))]);

    // PTR alone names an instance but cannot address it.
    expect(firstDiscoveryResult(ingest(ptrOnly))).toBeNull();
    // PTR + SRV is already usable via the advertised hostname…
    expect(firstDiscoveryResult(ingest(ptrOnly, srvOnly))).toEqual({
      url: 'http://ha-host.local:8123',
      name: 'Home',
    });
    // …and the A record, arriving in its own later datagram, can only be attached to that
    // instance by consulting the SRV target carried over from the earlier one.
    expect(firstDiscoveryResult(ingest(ptrOnly, srvOnly, aOnly))).toEqual({
      url: 'http://192.0.2.11:8123',
      name: 'Home',
    });
  });

  it('does not let a later response blank out what an earlier one established', () => {
    const state = ingest(
      fullAnnouncement(),
      response([record(HA_SERVICE_TYPE, TYPE_PTR, encodeName(INSTANCE))]),
    );
    expect(firstDiscoveryResult(state)).toEqual({ url: 'http://192.0.2.10:8123', name: 'Home' });
  });

  it('ignores records for other service types sharing the bus', () => {
    const other = response([
      record('_printer._tcp.local', TYPE_PTR, encodeName('Office._printer._tcp.local')),
      record('Office._printer._tcp.local', TYPE_SRV, srvRdata(9100, 'printer.local')),
      record('printer.local', TYPE_A, aRdata('192.0.2.99')),
    ]);
    expect(ingest(other).instances.size).toBe(0);
  });

  it('ignores malformed and truncated datagrams rather than throwing', () => {
    const truncated = fullAnnouncement().subarray(0, 20);
    expect(() => ingest(Buffer.alloc(0), Buffer.from([1, 2, 3]), truncated)).not.toThrow();
    expect(firstDiscoveryResult(ingest(truncated))).toBeNull();
  });
});

describe('discoveredUrl', () => {
  const base: DiscoveredInstance = {
    fqdn: INSTANCE,
    name: 'Home',
    port: 8123,
    target: 'ha-host.local',
    address: '192.0.2.10',
    txt: {},
  };

  it("prefers Home Assistant's own internal URL over the reconstructed one", () => {
    expect(discoveredUrl({ ...base, txt: { internal_url: 'http://ha-host.local:8123/' } })).toBe(
      'http://ha-host.local:8123',
    );
  });

  it('prefers the internal URL over an external one that may not route from here', () => {
    const txt = { external_url: 'https://ha.example.com', internal_url: 'http://ha-host.local:8123' };
    expect(discoveredUrl({ ...base, txt })).toBe('http://ha-host.local:8123');
  });

  it('falls back to the SRV target when no address was seen, and to nothing at all when unresolvable', () => {
    expect(discoveredUrl({ ...base, address: undefined })).toBe('http://ha-host.local:8123');
    expect(discoveredUrl({ ...base, address: undefined, target: undefined })).toBeNull();
    expect(discoveredUrl({ ...base, port: undefined })).toBeNull();
  });

  it('ignores a TXT URL that is not a usable http(s) address', () => {
    // No scheme, a non-http scheme, and a truncated one that a bare `^https?://` test would let
    // through and then reduce to the nonsense base URL "http:".
    for (const internal_url of ['ha-host.local:8123', 'ftp://ha-host.local', 'http://', '']) {
      expect(discoveredUrl({ ...base, txt: { internal_url } })).toBe('http://192.0.2.10:8123');
    }
  });

  it('normalises an advertised URL down to a bare origin', () => {
    expect(discoveredUrl({ ...base, txt: { internal_url: 'http://ha-host.local:8123/lovelace?x=1' } })).toBe(
      'http://ha-host.local:8123',
    );
  });

  it('reads the advertised URL through to the folded state', () => {
    const state = ingest(fullAnnouncement(['internal_url=http://ha-host.local:8123', 'version=2026.1.0']));
    expect(firstDiscoveryResult(state)).toEqual({ url: 'http://ha-host.local:8123', name: 'Home' });
  });
});

describe('resolveHaDiscoveryPlan', () => {
  const on = { homeAssistant: true, enabled: true, configuredUrl: undefined };

  it('discovers only when Home Assistant reads are on, discovery is opted into, and no URL is set', () => {
    expect(resolveHaDiscoveryPlan(on)).toEqual({ discover: true, reason: 'discover' });
  });

  it('stays off unless opted into, like every other network-touching feature', () => {
    expect(resolveHaDiscoveryPlan({ ...on, enabled: false })).toEqual({
      discover: false,
      reason: 'disabled',
    });
  });

  it('never runs when the Home Assistant read path itself is off', () => {
    expect(resolveHaDiscoveryPlan({ ...on, homeAssistant: false })).toEqual({
      discover: false,
      reason: 'off',
    });
  });

  it('lets an explicitly configured URL win', () => {
    expect(resolveHaDiscoveryPlan({ ...on, configuredUrl: 'http://ha.test:8123' })).toEqual({
      discover: false,
      reason: 'configured',
    });
  });
});
