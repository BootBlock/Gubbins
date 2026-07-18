/**
 * SSRF guard for outbound webhook delivery (webhooks plan `W5`; see
 * `docs/todo/done/webhooks_2026-07-18.md` §6.2).
 *
 * A webhook URL is user-supplied, and the bridge is the one thing in the system that sits **on the
 * LAN** and can reach what the browser cannot — the router's admin page, a printer, a Kubernetes
 * kubelet, a cloud instance's metadata service. With direct-from-browser delivery dropped (§6.3),
 * every delivery now leaves from here, which makes this the feature's primary security control
 * rather than a footnote.
 *
 * The rule: **a destination that resolves to a loopback, link-local, cloud-metadata, private or
 * otherwise non-public address is refused**, unless the operator explicitly opts in with
 * `GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on`. That mirrors the bridge's existing off-by-default
 * posture for everything with reach (writes, push, MQTT, Home Assistant): the capability exists,
 * but it is never on because nobody said so.
 *
 * ## Why DNS is resolved rather than the hostname pattern-matched
 *
 * Refusing the literal `127.0.0.1` while allowing `evil.example` — which its owner points at
 * `127.0.0.1` — would be a guard in name only; "DNS rebinding" is the standard way that check is
 * defeated. So a non-literal host is **resolved**, and *every* address it resolves to must be
 * public. The resolver is injected so tests never touch the network, and a resolution failure is a
 * **refusal**, not a pass: an address we could not classify is one we cannot vouch for.
 *
 * A residual TOCTOU gap remains — the name could resolve differently between this check and the
 * `fetch` — and closing it fully needs pinned-IP connections, which Node's `fetch` does not expose.
 * That is documented here rather than papered over: this guard raises the cost substantially and
 * the honest posture is that the opt-in flag, not the check, is what an operator on a hostile LAN
 * should be reasoning about.
 *
 * Imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`, no
 * `namespace`, no TS parameter properties.
 */
import { lookup } from 'node:dns/promises';

/** Whether the operator opted into delivering to private/loopback destinations. */
export interface WebhookSsrfPolicy {
  /**
   * `true` only when `GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on`. Skips the address classification
   * entirely — an operator who deliberately webhooks their own Home Assistant on `192.168.1.x` has
   * said so, and we do not second-guess it.
   */
  readonly allowPrivate: boolean;
}

/**
 * Resolve a hostname to every address it maps to. Injected so tests are offline; defaults to the
 * system resolver.
 */
export type WebhookHostResolver = (hostname: string) => Promise<readonly string[]>;

/** The verdict. A refusal always carries a short, **URL-free** reason safe to log. */
export type WebhookDestinationVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** The cloud-metadata addresses that are the classic SSRF prize, refused by exact match. */
const METADATA_ADDRESSES: readonly string[] = [
  '169.254.169.254', // AWS / Azure / GCP / DigitalOcean / OpenStack
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv6
];

/** Hostnames that mean "this machine" without being IP literals. */
const LOOPBACK_NAMES: readonly string[] = ['localhost', 'localhost.localdomain', 'ip6-localhost'];

/**
 * The default resolver: the system's, asking for **every** address (`all: true`) rather than just
 * the first. A name with one public and one loopback address must be refused, and only the full
 * list can show that.
 */
const defaultResolver: WebhookHostResolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

/**
 * Strip an IPv6 literal's surrounding brackets and any zone index, and fold an IPv4-mapped IPv6
 * address (`::ffff:127.0.0.1`) down to its IPv4 form — otherwise `::ffff:127.0.0.1` would sail past
 * an IPv4 loopback check while connecting to exactly that.
 */
function normaliseAddress(raw: string): string {
  let address = raw.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  return mapped ? mapped[1]! : address;
}

/** Parse a dotted-quad into its four octets, or `null` when it is not one. */
function ipv4Octets(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Classify an address as non-public, returning the reason it is refused (or `null` when it looks
 * publicly routable).
 *
 * Deliberately a **deny-list of non-public ranges** rather than an allow-list of public ones: the
 * public space is "everything else", and enumerating it would be both enormous and wrong the moment
 * IANA allocates a new block.
 */
export function classifyPrivateAddress(raw: string): string | null {
  const address = normaliseAddress(raw);
  if (METADATA_ADDRESSES.includes(address)) return 'a cloud metadata address';

  const octets = ipv4Octets(address);
  if (octets !== null) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 0) return 'an unspecified address';
    if (a === 127) return 'a loopback address';
    if (a === 10) return 'a private address';
    if (a === 172 && b >= 16 && b <= 31) return 'a private address';
    if (a === 192 && b === 168) return 'a private address';
    if (a === 169 && b === 254) return 'a link-local address';
    if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
    if (a === 192 && b === 0) return 'a reserved address';
    if (a >= 224) return 'a multicast or reserved address';
    return null;
  }

  // IPv6 (or something unparseable — treated as unclassifiable below).
  if (!address.includes(':')) return 'an address that could not be classified';
  if (address === '::' || address === '::0') return 'an unspecified address';
  if (address === '::1') return 'a loopback address';
  // fe80::/10 is exactly fe80–febf, so all four nibbles of the first group are significant. An
  // optional fourth nibble here would also match `fe8::1` — which expands to 0fe8:… and is publicly
  // routable — and refuse a legitimate destination with a misleading reason.
  if (/^fe[89ab][0-9a-f]:/.test(address)) return 'a link-local address';
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return 'a unique-local address';
  if (/^ff[0-9a-f]{2}:/.test(address)) return 'a multicast address';
  return null;
}

/**
 * Decide whether a webhook may be delivered to `url`.
 *
 * The order matters. The scheme is checked first (a `file:`/`gopher:` URL never reaches DNS), then
 * the policy opt-in short-circuits, then the host is classified — as a literal when it is one, and
 * otherwise by resolving it and requiring **every** returned address to be public.
 */
export async function checkWebhookDestination(
  url: string,
  policy: WebhookSsrfPolicy,
  resolver: WebhookHostResolver = defaultResolver,
): Promise<WebhookDestinationVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'the URL could not be parsed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'the URL is not http(s)' };
  }
  // The opt-in is checked after the scheme so a `file:` URL is refused even with the flag on —
  // the flag says "my LAN is fine", not "issue any request at all".
  if (policy.allowPrivate) return { allowed: true };

  const hostname = normaliseAddress(parsed.hostname);
  if (hostname.length === 0) return { allowed: false, reason: 'the URL has no host' };
  if (LOOPBACK_NAMES.includes(hostname)) {
    return { allowed: false, reason: 'the host is a loopback name' };
  }

  // An IP literal is classified directly — there is nothing to resolve, and asking the resolver
  // about a literal would only add a failure mode.
  if (ipv4Octets(hostname) !== null || hostname.includes(':')) {
    const reason = classifyPrivateAddress(hostname);
    return reason === null ? { allowed: true } : { allowed: false, reason: `the host is ${reason}` };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'the host could not be resolved' };
  }
  if (addresses.length === 0) return { allowed: false, reason: 'the host resolved to no address' };

  for (const address of addresses) {
    const reason = classifyPrivateAddress(address);
    if (reason !== null) return { allowed: false, reason: `the host resolves to ${reason}` };
  }
  return { allowed: true };
}
