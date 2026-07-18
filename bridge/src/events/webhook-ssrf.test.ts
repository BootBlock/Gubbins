/**
 * SSRF guard tests (webhooks plan `W5`, §6.2).
 *
 * This is the feature's **primary security control** — with direct-from-browser delivery dropped,
 * every webhook leaves from the bridge, which sits on the LAN and can reach what a browser cannot.
 * So the coverage here is deliberately exhaustive about the refusal side rather than just the
 * happy path, and the DNS resolver is always injected: no test touches the network.
 */
import { describe, expect, it } from 'vitest';
import { checkWebhookDestination, classifyPrivateAddress } from './webhook-ssrf.ts';

const DENY = { allowPrivate: false };
const ALLOW = { allowPrivate: true };
/** Resolves everything to a documentation-range public address (RFC 5737 TEST-NET-3). */
const publicResolver = (): Promise<readonly string[]> => Promise.resolve(['203.0.113.10']);

describe('classifyPrivateAddress', () => {
  it('refuses every non-public IPv4 range', () => {
    expect(classifyPrivateAddress('127.0.0.1')).toMatch(/loopback/);
    expect(classifyPrivateAddress('10.0.0.5')).toMatch(/private/);
    expect(classifyPrivateAddress('172.16.4.1')).toMatch(/private/);
    expect(classifyPrivateAddress('172.31.255.254')).toMatch(/private/);
    expect(classifyPrivateAddress('192.168.1.1')).toMatch(/private/);
    expect(classifyPrivateAddress('169.254.1.1')).toMatch(/link-local/);
    expect(classifyPrivateAddress('100.64.0.1')).toMatch(/carrier-grade/);
    expect(classifyPrivateAddress('0.0.0.0')).toMatch(/unspecified/);
    expect(classifyPrivateAddress('224.0.0.1')).toMatch(/multicast|reserved/);
  });

  it('refuses the cloud-metadata addresses by exact match', () => {
    expect(classifyPrivateAddress('169.254.169.254')).toMatch(/metadata/);
    expect(classifyPrivateAddress('100.100.100.200')).toMatch(/metadata/);
    expect(classifyPrivateAddress('fd00:ec2::254')).toMatch(/metadata/);
  });

  it('refuses non-public IPv6, including unique-local and link-local', () => {
    expect(classifyPrivateAddress('::1')).toMatch(/loopback/);
    expect(classifyPrivateAddress('::')).toMatch(/unspecified/);
    expect(classifyPrivateAddress('fe80::1')).toMatch(/link-local/);
    expect(classifyPrivateAddress('fc00::1')).toMatch(/unique-local/);
    expect(classifyPrivateAddress('fd12:3456::1')).toMatch(/unique-local/);
    expect(classifyPrivateAddress('ff02::1')).toMatch(/multicast/);
  });

  it('folds an IPv4-mapped IPv6 address down before classifying it', () => {
    // The whole point: `::ffff:127.0.0.1` connects to loopback, so it must not slip past an
    // IPv4-shaped check by virtue of being written in IPv6 form.
    expect(classifyPrivateAddress('::ffff:127.0.0.1')).toMatch(/loopback/);
    expect(classifyPrivateAddress('::ffff:192.168.0.1')).toMatch(/private/);
    expect(classifyPrivateAddress('::ffff:203.0.113.10')).toBeNull();
  });

  it('strips brackets and a zone index before classifying', () => {
    expect(classifyPrivateAddress('[::1]')).toMatch(/loopback/);
    expect(classifyPrivateAddress('fe80::1%eth0')).toMatch(/link-local/);
  });

  it('accepts a publicly routable address', () => {
    expect(classifyPrivateAddress('203.0.113.10')).toBeNull();
    expect(classifyPrivateAddress('2606:4700::1111')).toBeNull();
  });
});

describe('checkWebhookDestination', () => {
  it('allows a public host that resolves publicly', async () => {
    const verdict = await checkWebhookDestination('https://hooks.example.test/x', DENY, publicResolver);
    expect(verdict.allowed).toBe(true);
  });

  it('refuses a loopback literal and the loopback names', async () => {
    for (const url of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://localhost/x']) {
      const verdict = await checkWebhookDestination(url, DENY, publicResolver);
      expect(verdict.allowed).toBe(false);
    }
  });

  it('refuses a private literal without ever consulting the resolver', async () => {
    let consulted = false;
    const resolver = (): Promise<readonly string[]> => {
      consulted = true;
      return Promise.resolve(['203.0.113.10']);
    };
    const verdict = await checkWebhookDestination('http://192.168.1.50/hook', DENY, resolver);
    expect(verdict.allowed).toBe(false);
    // A literal is classified directly — asking the resolver about it would only add a failure mode.
    expect(consulted).toBe(false);
  });

  it('refuses the cloud-metadata address', async () => {
    const verdict = await checkWebhookDestination('http://169.254.169.254/latest/meta-data/', DENY);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/metadata/);
  });

  it('refuses a public-looking name that resolves to loopback (the rebinding case)', async () => {
    // The reason the guard resolves rather than pattern-matching the hostname: refusing
    // `127.0.0.1` while trusting a name its owner points at `127.0.0.1` would be a guard in name only.
    const rebinding = (): Promise<readonly string[]> => Promise.resolve(['127.0.0.1']);
    const verdict = await checkWebhookDestination('https://evil.example.test/x', DENY, rebinding);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/loopback/);
  });

  it('refuses when ANY resolved address is non-public, not just the first', async () => {
    const mixed = (): Promise<readonly string[]> => Promise.resolve(['203.0.113.10', '10.0.0.1']);
    const verdict = await checkWebhookDestination('https://mixed.example.test/x', DENY, mixed);
    expect(verdict.allowed).toBe(false);
  });

  it('refuses when the host cannot be resolved, rather than passing it through', async () => {
    const failing = (): Promise<readonly string[]> => Promise.reject(new Error('ENOTFOUND'));
    const verdict = await checkWebhookDestination('https://nowhere.example.test/x', DENY, failing);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/resolve/);
  });

  it('refuses a host that resolves to no address at all', async () => {
    const empty = (): Promise<readonly string[]> => Promise.resolve([]);
    const verdict = await checkWebhookDestination('https://empty.example.test/x', DENY, empty);
    expect(verdict.allowed).toBe(false);
  });

  it('refuses a non-http(s) scheme, and keeps refusing it even with the opt-in on', async () => {
    // The flag means "my LAN is fine", not "issue any request at all".
    expect((await checkWebhookDestination('file:///etc/passwd', DENY, publicResolver)).allowed).toBe(false);
    expect((await checkWebhookDestination('file:///etc/passwd', ALLOW, publicResolver)).allowed).toBe(false);
  });

  it('refuses an unparseable URL', async () => {
    const verdict = await checkWebhookDestination('not a url', DENY, publicResolver);
    expect(verdict.allowed).toBe(false);
  });

  it('allows loopback, private and metadata destinations once the operator opts in', async () => {
    for (const url of [
      'http://127.0.0.1:8123/api/webhook/x',
      'http://192.168.1.50/hook',
      'http://localhost:1880/endpoint',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const verdict = await checkWebhookDestination(url, ALLOW, publicResolver);
      expect(verdict.allowed).toBe(true);
    }
  });

  it('never puts the URL in a refusal reason', async () => {
    const verdict = await checkWebhookDestination('http://192.168.1.50/secret-path?token=x', DENY);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).not.toContain('192.168');
      expect(verdict.reason).not.toContain('secret-path');
      expect(verdict.reason).not.toContain('token');
    }
  });
});
