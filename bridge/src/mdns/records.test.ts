/**
 * Pure mDNS / DNS-SD record tests — wire-format encode/decode, the (secret-free) TXT
 * builder, the opt-in/loopback gating, and the advertised-address pick. No sockets, no I/O.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTANCE_NAME,
  SERVICE_TYPE,
  buildTxtEntries,
  decodeQuestions,
  encodeAnnouncement,
  encodeName,
  instanceFqdn,
  isQuery,
  isQueryForService,
  pickAdvertisedAddress,
  resolveMdnsPlan,
  sanitizeHostLabel,
  type InterfaceAddress,
} from './records.ts';

const ADVERT = {
  hostLabel: 'gubbins-bridge',
  port: 8787,
  address: '192.0.2.10', // TEST-NET-1, never routable
  txt: { serverVersion: '0.0.1' },
};

describe('buildTxtEntries', () => {
  it('carries only non-secret identification (path / api / version), never a token', () => {
    const entries = buildTxtEntries({ serverVersion: '0.0.1' });
    expect(entries).toContain('path=/api/v1');
    expect(entries).toContain('api=v1');
    expect(entries).toContain('server=gubbins-bridge');
    expect(entries).toContain('version=0.0.1');
    // Belt-and-braces: nothing token/secret-shaped may ever appear in the advertisement.
    for (const entry of entries) {
      expect(entry.toLowerCase()).not.toMatch(/token|secret|bearer|password|auth/);
    }
  });
});

describe('encodeAnnouncement', () => {
  it('produces a DNS response with the four PTR/SRV/TXT/A answers', () => {
    const msg = encodeAnnouncement(ADVERT);
    expect(msg.readUInt16BE(2) & 0x8000).not.toBe(0); // QR=1 (a response)
    expect(msg.readUInt16BE(4)).toBe(0); // no questions
    expect(msg.readUInt16BE(6)).toBe(4); // four answers
  });

  it('round-trips the service type as the first (PTR) answer name', () => {
    const msg = encodeAnnouncement(ADVERT);
    // The first answer name begins immediately after the 12-byte header.
    const [first] = decodeQuestions(withOneQuestion(msg.subarray(12)));
    expect(first?.name.toLowerCase()).toBe(SERVICE_TYPE);
  });

  it('a goodbye sets TTL 0 on every record', () => {
    const live = encodeAnnouncement(ADVERT);
    const bye = encodeAnnouncement(ADVERT, { goodbye: true });
    expect(bye.length).toBe(live.length); // same records, only the TTL differs
    expect(bye).not.toEqual(live);
  });

  it('rejects an invalid IPv4 address for the A record', () => {
    expect(() => encodeAnnouncement({ ...ADVERT, address: '999.1.1.1' })).toThrow(/IPv4/);
  });
});

describe('encodeName / decodeQuestions', () => {
  it('round-trips a multi-label name through a synthesised query', () => {
    const query = buildQuery(SERVICE_TYPE, 12);
    const questions = decodeQuestions(query);
    expect(questions).toEqual([{ name: SERVICE_TYPE, type: 12 }]);
  });
});

describe('isQuery / isQueryForService', () => {
  it('treats a response as not a query', () => {
    expect(isQuery(encodeAnnouncement(ADVERT))).toBe(false);
  });

  it('matches a PTR query for the service type', () => {
    const questions = decodeQuestions(buildQuery(SERVICE_TYPE, 12));
    expect(isQueryForService(questions)).toBe(true);
  });

  it('matches an instance-name SRV query case-insensitively', () => {
    const questions = decodeQuestions(buildQuery(instanceFqdn().toUpperCase(), 33));
    expect(isQueryForService(questions)).toBe(true);
  });

  it('ignores an unrelated service type', () => {
    const questions = decodeQuestions(buildQuery('_spotify-connect._tcp.local', 12));
    expect(isQueryForService(questions)).toBe(false);
  });

  it('ignores the right name with the wrong record type (A)', () => {
    const questions = decodeQuestions(buildQuery(SERVICE_TYPE, 1));
    expect(isQueryForService(questions)).toBe(false);
  });
});

describe('resolveMdnsPlan', () => {
  it('is off by default (opt-out)', () => {
    expect(resolveMdnsPlan({ enabled: false, host: '0.0.0.0' })).toEqual({
      advertise: false,
      reason: 'disabled',
    });
  });

  it('auto-skips on a loopback bind even when enabled', () => {
    expect(resolveMdnsPlan({ enabled: true, host: '127.0.0.1' })).toEqual({
      advertise: false,
      reason: 'loopback',
    });
    expect(resolveMdnsPlan({ enabled: true, host: 'localhost' }).advertise).toBe(false);
  });

  it('advertises only when enabled AND LAN-exposed', () => {
    expect(resolveMdnsPlan({ enabled: true, host: '0.0.0.0' })).toEqual({
      advertise: true,
      reason: 'advertise',
    });
  });
});

describe('pickAdvertisedAddress', () => {
  const ifaces: Record<string, InterfaceAddress[]> = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.0.2.20' },
    ],
  };

  it('prefers an explicit concrete host', () => {
    expect(pickAdvertisedAddress(ifaces, '192.0.2.99')).toBe('192.0.2.99');
  });

  it('falls back to the first non-internal IPv4 for a wildcard bind', () => {
    expect(pickAdvertisedAddress(ifaces, '0.0.0.0')).toBe('192.0.2.20');
  });

  it('returns null when there is no routable IPv4', () => {
    expect(pickAdvertisedAddress({ lo: ifaces.lo }, '0.0.0.0')).toBeNull();
  });
});

describe('sanitizeHostLabel', () => {
  it('reduces a messy hostname to a single safe DNS label', () => {
    expect(sanitizeHostLabel('Workshop.NAS_01')).toBe('workshop-nas-01');
    expect(sanitizeHostLabel('   ')).toBe('gubbins-bridge');
  });
});

describe('default instance name', () => {
  it('is a stable, human-readable label', () => {
    expect(DEFAULT_INSTANCE_NAME).toBe('Gubbins Bridge');
    expect(instanceFqdn()).toBe(`${DEFAULT_INSTANCE_NAME}.${SERVICE_TYPE}`);
  });
});

// ── test helpers: synthesise a minimal mDNS query message ─────────────────────────────

/** Build a one-question DNS query for `name`/`qtype` (the shape HA's browser sends). */
function buildQuery(name: string, qtype: number): Buffer {
  const header = Buffer.alloc(12); // ID 0, flags 0 (a query), QDCOUNT 1
  header.writeUInt16BE(1, 4);
  const q = encodeName(name);
  const meta = Buffer.alloc(4);
  meta.writeUInt16BE(qtype, 0);
  meta.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, q, meta]);
}

/** Wrap a raw name+meta region so {@link decodeQuestions} can read its first name. */
function withOneQuestion(answerSection: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // pretend one question so decodeQuestions reads the name
  return Buffer.concat([header, answerSection]);
}
