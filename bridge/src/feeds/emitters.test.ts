/**
 * Pure syndication-emitter tests (EI-6) — RSS 2.0 / Atom 1.0 / JSON Feed 1.1 shape, escaping and
 * date formatting. No DB, no server: every input is constructed inline.
 */
import { describe, expect, it } from 'vitest';
import { emitAtom, emitJsonFeed, emitRss, escapeXml, isoDate, rfc822, type FeedChannel } from './emitters.ts';
import type { FeedItem } from './feed-model.ts';

const CHANNEL: FeedChannel = {
  title: 'Gubbins activity',
  description: 'Recent inventory activity from Gubbins.',
  homeUrl: 'http://127.0.0.1:8787',
  selfUrl: 'http://127.0.0.1:8787/api/v1/activity.rss',
  updated: Date.UTC(2025, 5, 27, 6, 13, 20), // 2025-06-27T06:13:20Z
};

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'hist-0007',
    type: 'stock.adjusted',
    kind: 'stock',
    title: 'ESP32 Dev Board — Quantity changed',
    summary: 'Checked out 4.',
    itemId: 'item-esp32',
    itemName: 'ESP32 Dev Board',
    itemActive: true,
    occurredAt: Date.UTC(2025, 5, 27, 6, 13, 20),
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes the five XML metacharacters, ampersand first', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('rfc822 / isoDate', () => {
  it('formats an instant as an RFC 822 GMT date (RSS) and ISO-8601 (Atom/JSON)', () => {
    const ms = Date.UTC(2025, 5, 27, 6, 13, 20);
    expect(rfc822(ms)).toBe('Fri, 27 Jun 2025 06:13:20 GMT');
    expect(isoDate(ms)).toBe('2025-06-27T06:13:20.000Z');
  });
});

describe('emitRss', () => {
  it('emits a channel with a non-permalink guid and an RFC 822 pubDate per item', () => {
    const xml = emitRss(CHANNEL, [item()]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<title>Gubbins activity</title>');
    expect(xml).toContain('<lastBuildDate>Fri, 27 Jun 2025 06:13:20 GMT</lastBuildDate>');
    expect(xml).toContain('<guid isPermaLink="false">urn:gubbins:activity:hist-0007</guid>');
    expect(xml).toContain('<title>ESP32 Dev Board — Quantity changed</title>');
    expect(xml).toContain('<category>stock</category>');
    expect(xml).toContain('<pubDate>Fri, 27 Jun 2025 06:13:20 GMT</pubDate>');
  });

  it('escapes a hostile item title/summary so it cannot inject feed structure', () => {
    const xml = emitRss(CHANNEL, [item({ title: 'A & B <script>', summary: '"quoted"' })]);
    expect(xml).toContain('<title>A &amp; B &lt;script&gt;</title>');
    expect(xml).toContain('<description>&quot;quoted&quot;</description>');
    expect(xml).not.toContain('<script>');
  });

  it('emits a valid empty channel when there are no items', () => {
    const xml = emitRss(CHANNEL, []);
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });
});

describe('emitAtom', () => {
  it('emits a feed with a self link, a URN entry id and an ISO updated stamp', () => {
    const xml = emitAtom(CHANNEL, [item()]);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<link rel="self" href="http://127.0.0.1:8787/api/v1/activity.rss"/>');
    expect(xml).toContain('<id>urn:gubbins:activity:hist-0007</id>');
    expect(xml).toContain('<updated>2025-06-27T06:13:20.000Z</updated>');
    expect(xml).toContain('<category term="stock"/>');
  });
});

describe('emitJsonFeed', () => {
  it('emits JSON Feed 1.1 with a URN id, tag and the _gubbins extension', () => {
    const doc = JSON.parse(emitJsonFeed(CHANNEL, [item({ itemActive: false })]));
    expect(doc.version).toBe('https://jsonfeed.org/version/1.1');
    expect(doc.title).toBe('Gubbins activity');
    expect(doc.items).toHaveLength(1);
    const entry = doc.items[0];
    expect(entry.id).toBe('urn:gubbins:activity:hist-0007');
    expect(entry.title).toBe('ESP32 Dev Board — Quantity changed');
    expect(entry.content_text).toBe('Checked out 4.');
    expect(entry.date_published).toBe('2025-06-27T06:13:20.000Z');
    expect(entry.tags).toEqual(['stock']);
    expect(entry._gubbins).toEqual({
      type: 'stock.adjusted',
      itemId: 'item-esp32',
      itemName: 'ESP32 Dev Board',
      itemActive: false,
    });
  });

  it('serialises a hostile title safely (JSON.stringify handles escaping)', () => {
    const raw = emitJsonFeed(CHANNEL, [item({ title: 'A "B" <c> & d' })]);
    // Round-trips cleanly and the raw text carries no unescaped double-quote inside the value.
    const doc = JSON.parse(raw);
    expect(doc.items[0].title).toBe('A "B" <c> & d');
  });
});
