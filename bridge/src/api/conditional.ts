/**
 * Conditional-request support (RFC 9110 §8.8 + §13) for the bridge's polled subscription feeds.
 *
 * The calendar, the syndication feeds and the metrics exposition are *polled*, not requested once:
 * a calendar client refetches a subscribed `.ics` on a fixed interval, and some poll far more
 * often than that. Every poll used to re-run each repository projection behind the feed and ship
 * the whole document, because the responses carried `no-store` and no validator — a client had
 * nothing to revalidate against (issue #363).
 *
 * The bridge already holds exactly the right validator. Every feed is a projection of a snapshot
 * that is swapped wholesale, so its representation can only change when the snapshot re-hydrates
 * — or, for the calendar, when one of its day-grained cut-offs rolls over (see
 * `calendarModifiedAt` in `ical/feed.ts`). That instant is the `Last-Modified`; a weak entity-tag over
 * it plus a variant key (the query that selected this representation) is the `ETag`. A revalidated
 * poll then costs a header exchange instead of four projections over the whole vault.
 *
 * **Weak** (`W/`) is the honest strength: two responses built from the same snapshot are
 * *semantically* equivalent but need not be byte-identical (a projection's row ordering can shift
 * under it), which is precisely what a weak validator asserts — and `If-None-Match` compares
 * weakly regardless (RFC 9110 §8.8.3.2).
 */
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** The cache validators a feed response carries, and revalidates against on the next poll. */
export interface CacheValidators {
  /** The weak entity-tag, quoted and `W/`-prefixed — ready to use as the `ETag` header value. */
  readonly etag: string;
  /** The `Last-Modified` value in the IMF-fixdate form RFC 9110 §5.6.7 requires. */
  readonly lastModified: string;
}

/** The conditional headers a request may carry; absent when the client sent none. */
export interface ConditionalHeaders {
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
}

/**
 * Derive the validators for a representation that last changed at `modifiedAtMs` and is selected
 * by `variant` — a string identifying *which* representation this is (the feed and the query
 * parameters that shaped it). Two representations of the same snapshot that differ in their
 * variant get different entity-tags, so a client revalidating one is never handed a `304` earned
 * by the other.
 *
 * The instant is floored to whole seconds first, because `Last-Modified` has no sub-second
 * resolution: without the floor two modification instants inside the same second would produce
 * different entity-tags but an identical `Last-Modified`, and the two validators would disagree.
 */
export function cacheValidators(modifiedAtMs: number, variant: string): CacheValidators {
  const seconds = Math.floor(modifiedAtMs / 1000) * 1000;
  // A digest, not the raw variant: the variant carries the request URL (which on the feed paths
  // may carry a `?token=`), and an entity-tag is echoed back to the client and stored in caches.
  // Truncated because an entity-tag only has to be unguessably distinct, not collision-proof.
  const digest = createHash('sha256').update(`${variant}\u0000${seconds}`).digest('base64url').slice(0, 22);
  return { etag: `W/"${digest}"`, lastModified: new Date(seconds).toUTCString() };
}

/** Read the conditional headers off a request; each is omitted when the client did not send it. */
export function readConditionalHeaders(headers: IncomingHttpHeaders): ConditionalHeaders {
  const ifNoneMatch = headers['if-none-match'];
  const ifModifiedSince = headers['if-modified-since'];
  return {
    ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
    ...(ifModifiedSince !== undefined ? { ifModifiedSince } : {}),
  };
}

/**
 * Whether the client's cached copy is still current, i.e. whether to answer `304 Not Modified`.
 *
 * `If-None-Match` takes precedence and `If-Modified-Since` is only consulted in its absence, as
 * RFC 9110 §13.2.2 requires — an ETag is the stronger signal, so a client that sent both has
 * already been answered by the first. An unparseable `If-Modified-Since` is ignored rather than
 * guessed at, which sends the full response: the safe direction.
 */
export function isNotModified(
  conditional: ConditionalHeaders | undefined,
  validators: CacheValidators,
): boolean {
  if (conditional === undefined) return false;
  if (conditional.ifNoneMatch !== undefined) return etagMatches(conditional.ifNoneMatch, validators.etag);
  if (conditional.ifModifiedSince !== undefined) {
    const since = Date.parse(conditional.ifModifiedSince);
    return Number.isFinite(since) && Date.parse(validators.lastModified) <= since;
  }
  return false;
}

/**
 * Weak comparison (RFC 9110 §8.8.3.2) of an `If-None-Match` list against the tag we would serve:
 * `W/` is stripped from both sides and the opaque tags are compared verbatim. `*` matches any
 * current representation, so it is a match whenever we are about to serve one.
 *
 * Splitting the list on commas is safe here because the only tags that can *match* are ones this
 * bridge minted, and those are base64url — a foreign tag containing a comma can only be mangled
 * into a non-match, which is the direction that costs a full response rather than a stale one.
 */
function etagMatches(header: string, etag: string): boolean {
  const served = opaqueTag(etag);
  return header.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || opaqueTag(trimmed) === served;
  });
}

/** An entity-tag with its weakness prefix removed, for weak comparison. */
function opaqueTag(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * Parse a snapshot's `generatedAt` (an ISO-8601 string) back to UNIX-ms, or `null` when it is
 * absent or unparseable. `null` means the bridge has no honest basis for a validator, and the
 * caller falls back to the uncached `no-store` behaviour rather than inventing one.
 */
export function snapshotInstant(generatedAt: string | null): number | null {
  if (generatedAt === null) return null;
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}
