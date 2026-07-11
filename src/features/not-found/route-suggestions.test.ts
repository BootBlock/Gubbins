import { describe, it, expect } from 'vitest';
import { extractQuerySegments, suggestRoutes, type RouteCandidate } from './route-suggestions';

const CANDIDATES: readonly RouteCandidate[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/projects', label: 'Projects' },
  { to: '/purchase-orders', label: 'Purchase orders' },
  { to: '/reports', label: 'Reports' },
  { to: '/settings', label: 'Settings' },
  { to: '/home-assistant', label: 'Home Assistant' },
];

describe('extractQuerySegments', () => {
  it('returns all non-empty segments deepest-first and strips the base path', () => {
    expect(extractQuerySegments('/Gubbins/inventroy', '/Gubbins')).toEqual(['inventroy']);
    expect(extractQuerySegments('/inventory/thing', undefined)).toEqual(['thing', 'inventory']);
  });

  it('normalises separators and case away', () => {
    expect(extractQuerySegments('/Purchase-Orders')).toEqual(['purchaseorders']);
  });

  it('is empty for a path with no meaningful segment', () => {
    expect(extractQuerySegments('/Gubbins/', '/Gubbins')).toEqual([]);
    expect(extractQuerySegments('/')).toEqual([]);
  });
});

describe('suggestRoutes', () => {
  it('suggests the intended page for a typo (transposition)', () => {
    const suggestions = suggestRoutes('/inventroy', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/inventory');
  });

  it('suggests the intended page for a partial / abbreviated path', () => {
    const suggestions = suggestRoutes('/proj', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/projects');
  });

  it('matches a singular slip against the plural route', () => {
    const suggestions = suggestRoutes('/purchase-order', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/purchase-orders');
  });

  it('matches against the display label, not just the path token', () => {
    // "homeassistant" is the label with separators removed — the route token is the same
    // here, but a whitespace-only label difference must still resolve.
    const suggestions = suggestRoutes('/home-assistent', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/home-assistant');
  });

  it('matches an earlier segment when a nested path does not resolve', () => {
    // /inventory/99999 — the leaf is meaningless, but the real page is named earlier in it.
    const suggestions = suggestRoutes('/inventory/99999', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/inventory');
  });

  it('returns nothing for a genuinely unrelated path', () => {
    expect(suggestRoutes('/notreal', CANDIDATES)).toEqual([]);
  });

  it('returns nothing when there is no segment to match', () => {
    expect(suggestRoutes('/Gubbins/', CANDIDATES, { basepath: '/Gubbins' })).toEqual([]);
  });

  it('honours the base path when extracting the segment', () => {
    const suggestions = suggestRoutes('/Gubbins/setting', CANDIDATES, { basepath: '/Gubbins' });
    expect(suggestions[0]?.candidate.to).toBe('/settings');
  });

  it('caps the number of suggestions', () => {
    const suggestions = suggestRoutes('/s', CANDIDATES, { limit: 2, threshold: 0 });
    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it('orders suggestions best-match first', () => {
    const suggestions = suggestRoutes('/report', CANDIDATES);
    expect(suggestions[0]?.candidate.to).toBe('/reports');
    // scores are monotonically non-increasing
    const scores = suggestions.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
