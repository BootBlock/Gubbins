/**
 * The lookup runner (issue #616, phase L1) — the one place a lookup crosses to the network.
 *
 * Two responsibilities, both of which have to be *somewhere* and neither of which belongs in a
 * component:
 *
 * 1. **Rate limiting the source, not the call site.** A provider declares `minIntervalMs` because
 *    it is the *source's* policy (MusicBrainz asks for at most one request a second; Wikidata
 *    throttles SPARQL). The runner serialises every request to a provider through one promise
 *    chain and spaces them, so ten panels on screen cannot between them hammer a host that asked
 *    them not to — and no call site has to remember the rule.
 * 2. **Turning every failure into a value.** A lookup can fail by being offline, by CSP, by a
 *    404, by an unreadable body. All of them come back as `{ ok: false, failure }`, so the UI has
 *    exactly one shape to render and a network hiccup can never surface as an unhandled rejection.
 *
 * The **host allow-list gate is re-applied here**, not trusted from the provider. A descriptor
 * builds its own URLs, so in practice they are within its declared hosts — but this is the last
 * point before a network call, and re-checking is what makes "the app fetches only the hosts a
 * provider declared" a property of the code rather than of every provider author's care.
 *
 * `fetchImpl` and `wait` are injectable so the whole thing is unit-testable with no network and
 * no real clock.
 */
import type { LookupProvider, LookupRequest, LookupResult } from './types';

/**
 * Performs one already-gated request and returns its raw body (or the reason it has none).
 *
 * Two implementations exist: the runner's own consented `fetch`, and the companion extension's
 * privileged fetch over the §9 bridge. Both are rate-limited by the runner, because the interval
 * a source asks for is a property of *the source* and does not care which of the two made the
 * call.
 */
export type LookupFetcher = (request: LookupRequest) => Promise<LookupResult<string>>;

/** Injectable seams, so a test drives the runner with no network and no real timers. */
export interface LookupRunnerOptions {
  readonly fetchImpl?: typeof fetch;
  /** Resolves after `ms`; injected so a test can assert the spacing without waiting for it. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Injected clock, in ms. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether `url` is one of `hosts`, exactly.
 *
 * An **exact host match**, not a suffix match: a provider names the hosts it reaches, and
 * `wikidata.org.evil.test` must not pass for `wikidata.org`. https only — a lookup has no
 * business on a plaintext connection, and a userinfo component can disguise the host entirely.
 */
export function isProviderUrl(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  const host = parsed.hostname.toLowerCase();
  return hosts.some((allowed) => allowed.toLowerCase() === host);
}

/**
 * A per-provider serialising, rate-limited fetcher.
 *
 * One instance per app, shared by every panel: the spacing is only a real limit if all callers go
 * through the same queue. Held as a module-level singleton by {@link getLookupRunner}, and
 * constructible directly in tests.
 */
export class LookupRunner {
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** The tail of each provider's request chain, so requests to one provider never overlap. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** When each provider was last actually requested, so the next request can be spaced from it. */
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: LookupRunnerOptions = {}) {
    // Bound to the global `fetch` rather than passed bare: an unbound `fetch` reference throws an
    // "illegal invocation" in the browser.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.wait = options.wait ?? realWait;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Perform one provider request and read its body, spaced from that provider's previous request.
   *
   * Returns the raw body text; parsing it is the provider's job (and stays pure, so it is tested
   * against captured bodies rather than against a live source). `fetcher` overrides *who* performs
   * the request — the companion extension, when it is present — while keeping the queueing, the
   * spacing and the host gate in one place either way.
   */
  async request(
    provider: LookupProvider,
    request: LookupRequest,
    fetcher?: LookupFetcher,
  ): Promise<LookupResult<string>> {
    if (!isProviderUrl(request.url, provider.hosts)) {
      // Not a network failure but a programming one, reported through the same channel so it can
      // never escape as an exception from a click handler.
      return { ok: false, failure: { code: 'NETWORK' } };
    }

    const perform = () => this.perform(provider, request, fetcher);
    // Chain onto this provider's tail, and swallow the predecessor's rejection: one failed
    // request must not poison every later one queued behind it.
    const previous = this.queues.get(provider.id) ?? Promise.resolve();
    const run = previous.then(perform, perform);
    this.queues.set(provider.id, run);
    return run;
  }

  private async perform(
    provider: LookupProvider,
    request: LookupRequest,
    fetcher?: LookupFetcher,
  ): Promise<LookupResult<string>> {
    const last = this.lastRequestAt.get(provider.id);
    if (last !== undefined) {
      const remaining = provider.minIntervalMs - (this.now() - last);
      if (remaining > 0) await this.wait(remaining);
    }
    // Stamped before the request, not after: the interval a source asks for is between the
    // *starts* of two requests, and stamping on completion would let a slow response be followed
    // immediately by the next one.
    this.lastRequestAt.set(provider.id, this.now());

    if (fetcher !== undefined) {
      // A caller-supplied fetcher (the extension bridge) is still wrapped, so a rejection there
      // surfaces as the same `{ ok: false }` shape rather than escaping the queue.
      try {
        return await fetcher(request);
      } catch {
        return { ok: false, failure: { code: 'NETWORK' } };
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, { headers: { ...request.headers } });
    } catch {
      // A CSP-blocked request is indistinguishable from an offline one here, which is exactly why
      // the origin must be in `connect-src` — see `src/csp.ts`.
      return { ok: false, failure: { code: 'NETWORK' } };
    }
    if (!response.ok) {
      return { ok: false, failure: { code: 'HTTP', status: response.status } };
    }
    try {
      return { ok: true, value: await response.text() };
    } catch {
      return { ok: false, failure: { code: 'UNREADABLE' } };
    }
  }
}

let shared: LookupRunner | undefined;

/**
 * The app's shared runner. One instance, because per-provider spacing is only a real limit when
 * every caller queues behind the same tail.
 */
export function getLookupRunner(): LookupRunner {
  shared ??= new LookupRunner();
  return shared;
}
