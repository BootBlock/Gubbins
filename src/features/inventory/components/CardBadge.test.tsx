import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_CARD_BADGE_CONTENT, DEFAULT_CARD_BADGE_FALLBACK } from '../card-badge';
import { CardBadge } from './CardBadge';

/** A minimal DISCRETE item; override just the fields a case exercises. */
const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 4,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  barcode: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  isUnlimited: false,
  isFavourite: false,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};
const item = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({
    baseCurrency: 'GBP',
    locale: 'en-GB',
    cardBadgeContent: DEFAULT_CARD_BADGE_CONTENT,
    cardBadgeFallback: DEFAULT_CARD_BADGE_FALLBACK,
  });
});

describe('CardBadge', () => {
  it('renders the tracking pill by default (the shipped behaviour)', () => {
    render(<CardBadge item={item({ trackingMode: 'DISCRETE' })} />);
    expect(screen.getByText('Bulk')).toBeInTheDocument();
  });

  it('renders the unit price when configured and the item is priced', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'unitPrice', cardBadgeFallback: 'none' });
    const { container } = render(<CardBadge item={item({ unitCost: 2.5 })} />);
    // Money splits the symbol from the digits, so assert on the combined text content.
    expect(container).toHaveTextContent('£2.50');
  });

  it('renders the total value (unit cost × quantity) when configured', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'totalValue', cardBadgeFallback: 'none' });
    const { container } = render(<CardBadge item={item({ unitCost: 2.5, quantity: 4 })} />);
    expect(container).toHaveTextContent('£10.00');
  });

  it('renders the tinted condition label when configured', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'condition', cardBadgeFallback: 'none' });
    render(<CardBadge item={item({ condition: 'GOOD' })} />);
    const badge = screen.getByText('Good');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('text-cond-good');
  });

  it('falls back to the tracking pill when the chosen badge has nothing to show', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'unitPrice', cardBadgeFallback: 'tracking' });
    render(<CardBadge item={item({ unitCost: null, trackingMode: 'SERIALISED' })} />);
    expect(screen.getByText('Serialised')).toBeInTheDocument();
  });

  it('renders nothing when both the primary and the fallback are unavailable', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'unitPrice', cardBadgeFallback: 'none' });
    const { container } = render(<CardBadge item={item({ unitCost: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('passes the caller className through to the rendered badge', () => {
    usePreferencesStore.setState({ cardBadgeContent: 'condition', cardBadgeFallback: 'none' });
    render(<CardBadge item={item({ condition: 'MINT' })} className="hidden sm:inline-flex" />);
    expect(screen.getByText('Mint').className).toContain('hidden');
  });
});
