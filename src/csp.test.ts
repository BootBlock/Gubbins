import { describe, it, expect } from 'vitest';
import { buildContentSecurityPolicy, policyAllowsConnectOrigin, toCspOrigin, withCspMeta } from './csp';

/**
 * The Content-Security-Policy seam (issue #385).
 *
 * Most of this file is compile-time constant, and the parts that aren't carry the whole weight of
 * the fix: one **user-supplied** origin now reaches `connect-src`, and the app shell's `<meta>` is
 * rewritten at serve time so the two delivered forms agree (a browser enforces their
 * intersection, so a header the meta does not also permit buys nothing).
 *
 * The tests that matter most are the hostile ones. A value typed into a text field, persisted, and
 * passed across a `postMessage` boundary is the only non-literal that ever enters a policy string,
 * so a value able to *terminate* a source list would rewrite the policy rather than extend it —
 * turning a hardening feature into the hole it exists to prevent.
 */

const BRIDGE = 'http://gubbins-bridge.test:8787';

describe('toCspOrigin — the one gate a user-supplied value passes through', () => {
  it('reduces a bridge URL to the bare origin a CSP host-source can carry', () => {
    expect(toCspOrigin(BRIDGE)).toBe(BRIDGE);
    expect(toCspOrigin(`  ${BRIDGE}/api/v1/snapshot?x=1#frag  `)).toBe(BRIDGE);
    expect(toCspOrigin('https://bridge.example.com')).toBe('https://bridge.example.com');
    expect(toCspOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(toCspOrigin('http://[::1]:8787')).toBe('http://[::1]:8787');
    // Not DNS-valid, but routine for a container or LAN name — and `lib/bridge-url.ts` accepts
    // it, so rejecting it here would leave the app trying an address the policy never names.
    expect(toCspOrigin('http://gubbins_bridge:8787')).toBe('http://gubbins_bridge:8787');
  });

  it('refuses anything that could end one directive and begin another', () => {
    // Each of these, spliced in raw, would let a caller *replace* the policy: the first two by
    // closing `connect-src` and opening a wide-open `script-src`, the third by adding a second
    // source the user never configured.
    expect(toCspOrigin("http://evil.test; script-src 'unsafe-inline' *")).toBeNull();
    expect(toCspOrigin('http://evil.test;script-src *')).toBeNull();
    expect(toCspOrigin('http://evil.test https://also-evil.test')).toBeNull();
    expect(toCspOrigin('http://evil.test,https://also-evil.test')).toBeNull();
    expect(toCspOrigin("http://evil.test'")).toBeNull();
  });

  it('refuses schemes the bridge cannot live on, and anything unparseable', () => {
    expect(toCspOrigin('javascript:alert(1)')).toBeNull();
    expect(toCspOrigin('data:text/html,x')).toBeNull();
    expect(toCspOrigin('file:///etc/hosts')).toBeNull();
    expect(toCspOrigin('ws://bridge.test:8787')).toBeNull();
    expect(toCspOrigin('127.0.0.1:8787')).toBeNull();
    expect(toCspOrigin('')).toBeNull();
    expect(toCspOrigin('   ')).toBeNull();
  });

  it('drops credentials rather than carrying them into a policy string', () => {
    expect(toCspOrigin('http://user:secret@gubbins-bridge.test:8787')).toBe(BRIDGE);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('emits the committed policy unchanged when no bridge origin is registered', () => {
    const policy = buildContentSecurityPolicy();
    expect(policy).toContain(
      "connect-src 'self' https://www.googleapis.com https://world.openfoodfacts.org https://www.wikidata.org https://query.wikidata.org;",
    );
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain('unsafe-inline; ');
  });

  it('extends only connect-src with the registered bridge origin', () => {
    const withBridge = buildContentSecurityPolicy({ bridgeOrigin: BRIDGE });
    expect(withBridge).toContain(
      `connect-src 'self' https://www.googleapis.com https://world.openfoodfacts.org https://www.wikidata.org https://query.wikidata.org ${BRIDGE};`,
    );
    // Every other directive is byte-identical: this widens one list, it does not relax the policy.
    const baseline = buildContentSecurityPolicy();
    expect(withBridge.replace(` ${BRIDGE};`, ';')).toBe(baseline);
  });

  it('re-validates the origin rather than trusting its caller', () => {
    expect(buildContentSecurityPolicy({ bridgeOrigin: 'http://evil.test; script-src *' })).toBe(
      buildContentSecurityPolicy(),
    );
  });

  it('drops frame-ancestors from the meta form, with or without a bridge origin', () => {
    expect(buildContentSecurityPolicy({ forMeta: true })).not.toContain('frame-ancestors');
    const meta = buildContentSecurityPolicy({ forMeta: true, bridgeOrigin: BRIDGE });
    expect(meta).not.toContain('frame-ancestors');
    expect(meta).toContain(BRIDGE);
  });
});

describe('withCspMeta — the served shell decides the delivered meta', () => {
  const shell = (content: string) =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${content}"><title>Gubbins</title></head><body></body></html>`;

  it('replaces the build-time policy with the one the worker computed', () => {
    const next = buildContentSecurityPolicy({ forMeta: true, bridgeOrigin: BRIDGE });
    const html = withCspMeta(shell(buildContentSecurityPolicy({ forMeta: true })), next);

    expect(html).toContain(`content="${next}"`);
    expect(html).toContain(BRIDGE);
    // One tag replaced, nothing else disturbed.
    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(html).toContain('<title>Gubbins</title>');
  });

  it('leaves a document with no CSP meta untouched (the dev server injects none)', () => {
    const html = '<!doctype html><html><head><title>Gubbins</title></head><body></body></html>';
    expect(withCspMeta(html, buildContentSecurityPolicy({ forMeta: true }))).toBe(html);
  });
});

describe('policyAllowsConnectOrigin — deciding whether to offer a reload', () => {
  it('reports the committed policy as blocking a bridge origin it does not name', () => {
    expect(policyAllowsConnectOrigin(buildContentSecurityPolicy({ forMeta: true }), BRIDGE)).toBe(false);
  });

  it('reports a policy that names the origin as allowing it', () => {
    const policy = buildContentSecurityPolicy({ forMeta: true, bridgeOrigin: BRIDGE });
    expect(policyAllowsConnectOrigin(policy, BRIDGE)).toBe(true);
    // Case-insensitively: hosts are, and the worker and the page normalise separately.
    expect(policyAllowsConnectOrigin(policy, 'HTTP://GUBBINS-BRIDGE.TEST:8787')).toBe(true);
  });

  it("counts 'self' only for a bridge sharing the app's own origin", () => {
    const policy = "default-src 'self'; connect-src 'self'";
    expect(policyAllowsConnectOrigin(policy, BRIDGE, BRIDGE)).toBe(true);
    expect(policyAllowsConnectOrigin(policy, BRIDGE, 'https://app.example.com')).toBe(false);
  });

  it('treats no delivered policy as no restriction — the dev server blocks nothing', () => {
    expect(policyAllowsConnectOrigin(null, BRIDGE)).toBe(true);
    expect(policyAllowsConnectOrigin('   ', BRIDGE)).toBe(true);
  });

  it('falls back to default-src, and to "unrestricted" when neither directive is set', () => {
    expect(policyAllowsConnectOrigin(`default-src 'self' ${BRIDGE}`, BRIDGE)).toBe(true);
    expect(policyAllowsConnectOrigin("default-src 'self'", BRIDGE)).toBe(false);
    expect(policyAllowsConnectOrigin("script-src 'self'", BRIDGE)).toBe(true);
  });

  it('recognises the wildcard and scheme sources a hand-edited policy might use', () => {
    expect(policyAllowsConnectOrigin('connect-src *', BRIDGE)).toBe(true);
    expect(policyAllowsConnectOrigin('connect-src http:', BRIDGE)).toBe(true);
    expect(policyAllowsConnectOrigin('connect-src https:', BRIDGE)).toBe(false);
  });
});
