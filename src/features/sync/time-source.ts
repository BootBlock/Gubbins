/**
 * HTTP time source for the §7.3 NTP-style offset guard (Phase 14).
 *
 * Browsers cannot speak UDP NTP, so the spec permits "a lightweight, reliable time
 * server (or the cloud provider's API header)". A {@link CloudProvider} that has no
 * authoritative clock of its own (e.g. the File System Access folder adapter returns
 * `null`) can fall back to this: a HEAD request whose `Date` response header gives a
 * server-stamped wall-clock time, which {@link computeClockOffset} turns into the
 * local-clock offset applied before LWW diffing.
 *
 * Same-origin by default: the `Date` header is *not* CORS-safelisted, so a cross-origin
 * read would need `Access-Control-Expose-Headers: Date`, which public endpoints rarely
 * set. Hitting our own origin (a GitHub Pages host) keeps the header readable with no
 * external dependency (native-first, §2.4.3). Every failure degrades to `null` (trust the
 * local clock) so a flaky network can never block or crash a sync.
 */

/** Parse an HTTP `Date` header into epoch milliseconds; `null` if absent/unparseable. */
export function parseHttpDate(header: string | null | undefined): number | null {
  if (!header) return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms : null;
}

export interface HttpTimeSourceOptions {
  /** Endpoint to time-stamp against. Defaults to the current origin (same-origin HEAD). */
  readonly url?: string;
  /** Injected `fetch` (tests); defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolve an authoritative server time (epoch ms) from an endpoint's `Date` header, or
 * `null` on any failure. Safe to call unconditionally — it never throws.
 */
export async function httpTimeSource(options: HttpTimeSourceOptions = {}): Promise<number | null> {
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return null;
  const url = options.url ?? defaultOrigin();
  if (!url) return null;
  try {
    const res = await doFetch(url, { method: 'HEAD', cache: 'no-store' });
    return parseHttpDate(res.headers.get('date'));
  } catch {
    return null;
  }
}

function defaultOrigin(): string | null {
  if (typeof location === 'undefined') return null;
  // Cache-bust so an intermediary cannot serve a stale `Date`.
  return `${location.origin}${location.pathname}?_t=${Date.now()}`;
}
