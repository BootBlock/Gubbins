/**
 * Hand-rolled syndication-feed emitters (EI-6) — RSS 2.0, Atom 1.0, and JSON Feed 1.1.
 *
 * Same stdlib-first posture as the bridge's other encoders (the JSON-RPC framing, the mDNS wire
 * format, the iCal / YAML / OpenAPI-YAML emitters): a small, spec-specified subset written by
 * hand rather than a dependency (CLAUDE.md "minimal dependency surface"; the plan's stdlib-first
 * invariant). Each emitter covers exactly what the activity feed needs — a channel header plus
 * one entry per {@link FeedItem} — and nothing more.
 *
 * Pure and deterministic: no clock, no I/O, no DB. Every value (including the build timestamp) is
 * passed in, so each rule unit-tests directly. All human text flows through {@link escapeXml}
 * (XML feeds) or `JSON.stringify` (JSON Feed), so a hostile item name can't inject feed structure.
 */
import type { FeedItem } from './feed-model.ts';

/** Channel-level metadata shared by all three formats. */
export interface FeedChannel {
  /** The feed's display title, e.g. "Gubbins activity". */
  readonly title: string;
  /** A one-line channel description. */
  readonly description: string;
  /** The bridge's own base URL (host page). Never carries the auth token. */
  readonly homeUrl: string;
  /** The canonical URL of this feed document. Never carries the auth token (stripped upstream). */
  readonly selfUrl: string;
  /** The build/generation instant (UNIX-ms) — the snapshot's generation time when known. */
  readonly updated: number;
}

/**
 * The URN namespace for a feed entry's stable id (Atom `<id>` / RSS `<guid>` / JSON Feed `id`).
 * A host-free URN keeps the id stable regardless of the bridge's address and commits no real
 * host (CLAUDE.md). The ledger row id is appended verbatim.
 */
const ENTRY_URN_PREFIX = 'urn:gubbins:activity:';

/** The stable, host-free id for a feed entry, derived from its immutable ledger row id. */
function entryUrn(item: FeedItem): string {
  return `${ENTRY_URN_PREFIX}${item.id}`;
}

/**
 * The feed document's own permanent id (Atom `<id>`, RFC 4287 §4.2.6 — a universally unique IRI
 * that "MUST NOT change"). Deliberately *not* the self URL: that is built from the live request,
 * so it would differ per `?limit=` and per bridge address, and a reader would treat each variant
 * as a different feed. This URN is one feed, forever, wherever the bridge is reachable.
 *
 * It identifies *the* Gubbins activity feed rather than one installation's, so two bridges would
 * publish the same id — the deliberate trade for stability, since the only per-installation
 * discriminator available here is the request address, which is exactly what must not appear.
 */
const FEED_URN = 'urn:gubbins:feed:activity';

/**
 * The feed-level author name (Atom `<author>`, RFC 4287 §4.1.1 — required unless every entry
 * carries its own). The bridge is the publisher; entries are ledger rows with no per-person
 * attribution, and committing a real name here would leak personal data (CLAUDE.md).
 */
const FEED_AUTHOR_NAME = 'Gubbins';

/**
 * Escape a string for XML text or a double-quoted attribute (RSS + Atom). Ampersand first (so an
 * already-escaped entity isn't double-escaped), then the angle brackets and both quote styles.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Two-digit zero-pad. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const RFC822_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Format a UNIX-ms instant as an RFC 822 date-time in GMT (the RSS 2.0 `pubDate` format), e.g.
 * `Fri, 27 Jun 2025 06:13:20 GMT`. Uses UTC components so the output is timezone-stable.
 */
export function rfc822(unixMs: number): string {
  const d = new Date(unixMs);
  const day = RFC822_DAYS[d.getUTCDay()];
  const month = RFC822_MONTHS[d.getUTCMonth()];
  return (
    `${day}, ${pad2(d.getUTCDate())} ${month} ${d.getUTCFullYear()} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} GMT`
  );
}

/** Format a UNIX-ms instant as an ISO-8601 UTC timestamp (Atom + JSON Feed dates). */
export function isoDate(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

// --- RSS 2.0 ----------------------------------------------------------------------

/**
 * Emit an RSS 2.0 document. One `<item>` per feed item, each with a stable non-permalink
 * `<guid>` so a reader updates in place rather than duplicating on refetch.
 */
export function emitRss(channel: FeedChannel, items: readonly FeedItem[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(channel.title)}</title>`,
    `    <link>${escapeXml(channel.homeUrl)}</link>`,
    `    <description>${escapeXml(channel.description)}</description>`,
    `    <lastBuildDate>${rfc822(channel.updated)}</lastBuildDate>`,
    `    <generator>Gubbins Bridge</generator>`,
  ];
  for (const item of items) {
    lines.push(
      '    <item>',
      `      <title>${escapeXml(item.title)}</title>`,
      `      <description>${escapeXml(item.summary)}</description>`,
      `      <category>${escapeXml(item.kind)}</category>`,
      `      <guid isPermaLink="false">${escapeXml(entryUrn(item))}</guid>`,
      `      <pubDate>${rfc822(item.occurredAt)}</pubDate>`,
      '    </item>',
    );
  }
  lines.push('  </channel>', '</rss>', '');
  return lines.join('\n');
}

// --- Atom 1.0 ---------------------------------------------------------------------

/**
 * Emit an Atom 1.0 document. The feed `<id>` is a permanent host-free URN (never the
 * request-derived self URL — see {@link FEED_URN}) and the feed carries an `<author>` so the
 * document satisfies RFC 4287 §4.1.1; each `<entry>` carries the same host-free URN id as the
 * RSS `<guid>` so the two formats agree on entry identity.
 */
export function emitAtom(channel: FeedChannel, items: readonly FeedItem[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(channel.title)}</title>`,
    `  <subtitle>${escapeXml(channel.description)}</subtitle>`,
    `  <id>${FEED_URN}</id>`,
    `  <updated>${isoDate(channel.updated)}</updated>`,
    '  <author>',
    `    <name>${escapeXml(FEED_AUTHOR_NAME)}</name>`,
    '  </author>',
    `  <link rel="self" href="${escapeXml(channel.selfUrl)}"/>`,
    `  <link rel="alternate" href="${escapeXml(channel.homeUrl)}"/>`,
    `  <generator>Gubbins Bridge</generator>`,
  ];
  for (const item of items) {
    lines.push(
      '  <entry>',
      `    <title>${escapeXml(item.title)}</title>`,
      `    <id>${escapeXml(entryUrn(item))}</id>`,
      `    <updated>${isoDate(item.occurredAt)}</updated>`,
      `    <category term="${escapeXml(item.kind)}"/>`,
      `    <summary>${escapeXml(item.summary)}</summary>`,
      '  </entry>',
    );
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}

// --- JSON Feed 1.1 ----------------------------------------------------------------

/**
 * Emit a JSON Feed 1.1 document. Structure (not string concatenation) is built and handed to
 * `JSON.stringify`, so escaping is the serialiser's job — no injection surface. A small
 * `_gubbins` extension carries the item id/name and the stable dotted `type` for machine
 * consumers (the JSON Feed spec reserves `_`-prefixed keys for exactly this).
 */
export function emitJsonFeed(channel: FeedChannel, items: readonly FeedItem[]): string {
  const doc = {
    version: 'https://jsonfeed.org/version/1.1',
    title: channel.title,
    description: channel.description,
    home_page_url: channel.homeUrl,
    feed_url: channel.selfUrl,
    items: items.map((item) => ({
      id: entryUrn(item),
      title: item.title,
      content_text: item.summary,
      date_published: isoDate(item.occurredAt),
      tags: [item.kind],
      _gubbins: {
        type: item.type,
        itemId: item.itemId,
        itemName: item.itemName,
        itemActive: item.itemActive,
      },
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
