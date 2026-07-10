import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WISHLIST_PRIORITY,
  WISHLIST_PRIORITIES,
  WISHLIST_PRIORITY_LABELS,
  WISHLIST_PRIORITY_OPTIONS,
  WISHLIST_PRIORITY_RANK,
  isWishlistPriority,
  normaliseTargetPrice,
  normaliseWishlistName,
  normaliseWishlistNote,
  normaliseWishlistPriority,
  planWishlistEntry,
  sanitiseWishlistUrl,
  sortWishlist,
  summariseWishlist,
  type SortableWishlistEntry,
  type WishlistPriority,
} from './wishlist';

/**
 * Feature-gap G8 — the pure wishlist seam. Owns priority normalisation + ordering, link
 * sanitisation, the write-validation choke-point (`planWishlistEntry`), the display sort and the
 * summary aggregation. Exhaustively covered here in isolation (no React/DB/DOM).
 */
describe('wishlist priority vocabulary', () => {
  it('exposes the four priorities most-urgent first', () => {
    expect(WISHLIST_PRIORITIES).toEqual(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
    expect(DEFAULT_WISHLIST_PRIORITY).toBe('NONE');
  });

  it('ranks priorities by their declared order', () => {
    expect(WISHLIST_PRIORITY_RANK).toEqual({ HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 });
  });

  it('has a label for every priority', () => {
    for (const priority of WISHLIST_PRIORITIES) {
      expect(WISHLIST_PRIORITY_LABELS[priority]).toBeTruthy();
    }
  });

  it('lists options in urgency order', () => {
    expect(WISHLIST_PRIORITY_OPTIONS.map((o) => o.value)).toEqual([...WISHLIST_PRIORITIES]);
    expect(WISHLIST_PRIORITY_OPTIONS[0]).toEqual({ value: 'HIGH', label: 'High' });
  });

  it('type-guards known priorities', () => {
    expect(isWishlistPriority('HIGH')).toBe(true);
    expect(isWishlistPriority('none')).toBe(false); // guard is exact-case
    expect(isWishlistPriority('URGENT')).toBe(false);
    expect(isWishlistPriority(42)).toBe(false);
    expect(isWishlistPriority(null)).toBe(false);
  });

  it('normalises priorities forgivingly, softening the unknown to NONE', () => {
    expect(normaliseWishlistPriority('HIGH')).toBe('HIGH');
    expect(normaliseWishlistPriority('  medium ')).toBe('MEDIUM');
    expect(normaliseWishlistPriority('low')).toBe('LOW');
    expect(normaliseWishlistPriority('whatever')).toBe('NONE');
    expect(normaliseWishlistPriority('')).toBe('NONE');
    expect(normaliseWishlistPriority(null)).toBe('NONE');
    expect(normaliseWishlistPriority(undefined)).toBe('NONE');
  });
});

describe('normaliseWishlistName / normaliseWishlistNote', () => {
  it('trims to canonical form or null when blank', () => {
    expect(normaliseWishlistName('  Drill  ')).toBe('Drill');
    expect(normaliseWishlistName('')).toBeNull();
    expect(normaliseWishlistName('   ')).toBeNull();
    expect(normaliseWishlistName(null)).toBeNull();
    expect(normaliseWishlistName(undefined)).toBeNull();

    expect(normaliseWishlistNote('  buy on sale ')).toBe('buy on sale');
    expect(normaliseWishlistNote('   ')).toBeNull();
    expect(normaliseWishlistNote(null)).toBeNull();
  });
});

describe('sanitiseWishlistUrl', () => {
  it('returns null for a blank link', () => {
    expect(sanitiseWishlistUrl('')).toBeNull();
    expect(sanitiseWishlistUrl('   ')).toBeNull();
    expect(sanitiseWishlistUrl(null)).toBeNull();
    expect(sanitiseWishlistUrl(undefined)).toBeNull();
  });

  it('keeps a valid http(s) URL (normalised) and preserves path/query', () => {
    expect(sanitiseWishlistUrl('https://example.test/thing?x=1')).toBe('https://example.test/thing?x=1');
    expect(sanitiseWishlistUrl('http://example.test')).toBe('http://example.test/');
    expect(sanitiseWishlistUrl('  https://example.test/a  ')).toBe('https://example.test/a');
  });

  it('defaults a bare host/path to https://', () => {
    expect(sanitiseWishlistUrl('example.test/thing')).toBe('https://example.test/thing');
    expect(sanitiseWishlistUrl('shop.example.test')).toBe('https://shop.example.test/');
  });

  it('rejects non-web schemes (XSS-safety) as a bad link (undefined)', () => {
    expect(sanitiseWishlistUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitiseWishlistUrl('  JavaScript:alert(1) ')).toBeUndefined();
    expect(sanitiseWishlistUrl('data:text/html,<script>')).toBeUndefined();
    expect(sanitiseWishlistUrl('file:///etc/passwd')).toBeUndefined();
    expect(sanitiseWishlistUrl('ftp://example.test')).toBeUndefined();
  });

  it('rejects an unparseable link as a bad link (undefined)', () => {
    expect(sanitiseWishlistUrl('http://')).toBeUndefined();
    expect(sanitiseWishlistUrl('https://  ')).toBeUndefined();
  });
});

describe('normaliseTargetPrice', () => {
  it('treats null/undefined as no target', () => {
    expect(normaliseTargetPrice(null)).toBeNull();
    expect(normaliseTargetPrice(undefined)).toBeNull();
  });

  it('keeps a non-negative finite number (including zero)', () => {
    expect(normaliseTargetPrice(0)).toBe(0);
    expect(normaliseTargetPrice(12.99)).toBe(12.99);
  });

  it('flags a supplied-but-invalid figure as undefined', () => {
    expect(normaliseTargetPrice(-1)).toBeUndefined();
    expect(normaliseTargetPrice(Number.NaN)).toBeUndefined();
    expect(normaliseTargetPrice(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('planWishlistEntry', () => {
  it('normalises a full draft', () => {
    const plan = planWishlistEntry({
      name: '  Impact driver ',
      note: '  wait for a sale ',
      url: 'example.test/driver',
      targetPrice: 180,
      priority: 'high',
    });
    expect(plan).toEqual({
      ok: true,
      entry: {
        name: 'Impact driver',
        note: 'wait for a sale',
        url: 'https://example.test/driver',
        targetPrice: 180,
        priority: 'HIGH',
      },
    });
  });

  it('accepts a minimal draft (name only), defaulting the rest', () => {
    expect(planWishlistEntry({ name: 'Filters' })).toEqual({
      ok: true,
      entry: { name: 'Filters', note: null, url: null, targetPrice: null, priority: 'NONE' },
    });
  });

  it('rejects a blank name', () => {
    expect(planWishlistEntry({ name: '   ' })).toEqual({ ok: false, reason: 'EMPTY_NAME' });
  });

  it('rejects a non-web link', () => {
    expect(planWishlistEntry({ name: 'X', url: 'javascript:alert(1)' })).toEqual({
      ok: false,
      reason: 'INVALID_URL',
    });
  });

  it('rejects a negative / non-finite price', () => {
    expect(planWishlistEntry({ name: 'X', targetPrice: -5 })).toEqual({
      ok: false,
      reason: 'INVALID_PRICE',
    });
    expect(planWishlistEntry({ name: 'X', targetPrice: Number.NaN })).toEqual({
      ok: false,
      reason: 'INVALID_PRICE',
    });
  });

  it('checks name before link before price (deterministic first error)', () => {
    // All three fields are bad; the name error surfaces first.
    expect(planWishlistEntry({ name: '', url: 'javascript:void', targetPrice: -1 }).ok).toBe(false);
    expect(planWishlistEntry({ name: '', url: 'javascript:void', targetPrice: -1 })).toMatchObject({
      reason: 'EMPTY_NAME',
    });
    // Name fine, link bad, price bad → link error wins over price.
    expect(planWishlistEntry({ name: 'X', url: 'ftp://a', targetPrice: -1 })).toMatchObject({
      reason: 'INVALID_URL',
    });
  });
});

describe('sortWishlist', () => {
  const entry = (over: Partial<SortableWishlistEntry>): SortableWishlistEntry => ({
    id: 'id',
    name: 'name',
    priority: 'NONE',
    createdAt: 0,
    ...over,
  });

  it('orders by priority (High → None) first', () => {
    const sorted = sortWishlist([
      entry({ id: 'n', priority: 'NONE', name: 'a' }),
      entry({ id: 'h', priority: 'HIGH', name: 'z' }),
      entry({ id: 'l', priority: 'LOW', name: 'm' }),
      entry({ id: 'm', priority: 'MEDIUM', name: 'b' }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['h', 'm', 'l', 'n']);
  });

  it('breaks ties by name (case-insensitive), then oldest-first, then id', () => {
    const sorted = sortWishlist([
      entry({ id: 'b', priority: 'HIGH', name: 'apple', createdAt: 20 }),
      entry({ id: 'a', priority: 'HIGH', name: 'Apple', createdAt: 10 }),
      entry({ id: 'c', priority: 'HIGH', name: 'apple', createdAt: 10 }),
      entry({ id: 'd', priority: 'HIGH', name: 'Banana', createdAt: 5 }),
    ]);
    // apple(created 10, id c) < apple(created 10, id a? case-insensitive equal names) …
    // names equal (case-insensitive) → older first (10 before 20); among created=10, id asc.
    expect(sorted.map((e) => e.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('does not mutate its input', () => {
    const input = [entry({ id: 'n', priority: 'NONE' }), entry({ id: 'h', priority: 'HIGH' })];
    const snapshot = [...input];
    sortWishlist(input);
    expect(input).toEqual(snapshot);
  });
});

describe('summariseWishlist', () => {
  it('summarises an empty wishlist', () => {
    expect(summariseWishlist([])).toEqual({
      count: 0,
      totalTargetPrice: 0,
      pricedCount: 0,
      byPriority: { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 },
    });
  });

  it('counts, totals priced entries and tallies the priority mix', () => {
    const rows: { priority: WishlistPriority; targetPrice: number | null }[] = [
      { priority: 'HIGH', targetPrice: 100 },
      { priority: 'HIGH', targetPrice: null },
      { priority: 'LOW', targetPrice: 24.5 },
      { priority: 'NONE', targetPrice: 0 },
    ];
    expect(summariseWishlist(rows)).toEqual({
      count: 4,
      totalTargetPrice: 124.5,
      pricedCount: 3, // the null-priced HIGH entry is excluded; the 0-priced NONE counts
      byPriority: { HIGH: 2, MEDIUM: 0, LOW: 1, NONE: 1 },
    });
  });
});
