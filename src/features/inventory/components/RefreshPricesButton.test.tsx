import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item, SupplierPart } from '@/db/repositories';
import { peerSupports, type ProtocolCapability } from '@/features/scraping/protocol';
import { RefreshPricesButton } from './RefreshPricesButton';

const spies = vi.hoisted(() => ({
  update: vi.fn(),
  show: vi.fn(),
  requestScrape: vi.fn(() => 'req-1'),
  clear: vi.fn(),
  bridge: { ready: true, protocol: 5 } as { ready: boolean; protocol: number },
}));

// The item's supplier lookup module is on.
vi.mock('@/features/modules/useFeature', () => ({ useFeature: () => true }));

vi.mock('../mutations', () => ({
  useUpdateSupplierPart: () => ({ mutate: spies.update, isPending: false }),
}));

// Keep the real pure planners + labels; drive the bridge from the test.
vi.mock('@/features/scraping', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/scraping')>()),
  useScrapeBridge: () => ({
    ready: spies.bridge.ready,
    supports: (capability: ProtocolCapability) =>
      spies.bridge.ready && peerSupports(spies.bridge.protocol, capability),
    requests: {},
    requestScrape: spies.requestScrape,
    clear: spies.clear,
  }),
}));

// Inject a toast spy while keeping Button/Money/Tooltip real.
vi.mock('@/components/foundry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/foundry')>()),
  useToast: () => ({ show: spies.show, dismiss: vi.fn() }),
}));

const item = { id: 'item-1', name: 'Widget' } as Item;

function supplier(over: Partial<SupplierPart> = {}): SupplierPart {
  return {
    id: 'sp-1',
    itemId: 'item-1',
    supplierName: 'DigiKey',
    orderCode: null,
    unitCost: null,
    currency: null,
    packQty: null,
    minOrderQty: null,
    priceBreaks: [],
    url: 'https://www.digikey.com/en/products/detail/x/y/1',
    isPreferred: false,
    isPriceSource: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  spies.bridge.ready = true;
});

afterEach(() => {
  cleanup();
  spies.update.mockClear();
  spies.show.mockClear();
  spies.requestScrape.mockClear();
  spies.clear.mockClear();
});

const clickRefresh = () => fireEvent.click(screen.getByTestId('supplier-price-refresh'));

describe('RefreshPricesButton', () => {
  it('explains how to fix it when the item has no supplier (issue #28 requirement)', () => {
    render(<RefreshPricesButton item={item} parts={[]} />);
    clickRefresh();
    expect(spies.requestScrape).not.toHaveBeenCalled();
    expect(spies.show).toHaveBeenCalledTimes(1);
    expect(spies.show.mock.calls[0][0]).toMatchObject({ heading: 'No supplier set', tone: 'warning' });
  });

  it('prompts to install the companion extension when the bridge is not ready', () => {
    spies.bridge.ready = false;
    render(<RefreshPricesButton item={item} parts={[supplier()]} />);
    clickRefresh();
    expect(spies.requestScrape).not.toHaveBeenCalled();
    expect(spies.show.mock.calls[0][0]).toMatchObject({ heading: 'Companion extension needed' });
  });

  it('explains when no supplier has a background-fetchable URL', () => {
    render(
      <RefreshPricesButton
        item={item}
        parts={[supplier({ supplierName: 'Amazon', url: 'https://www.amazon.co.uk/dp/B0TEST0001' })]}
      />,
    );
    clickRefresh();
    expect(spies.requestScrape).not.toHaveBeenCalled();
    expect(spies.show.mock.calls[0][0]).toMatchObject({ heading: 'No fetchable supplier URL' });
  });

  it('scrapes each fetchable supplier URL and shows a refreshing state', () => {
    render(
      <RefreshPricesButton
        item={item}
        parts={[
          supplier({
            id: 'a',
            supplierName: 'DigiKey',
            url: 'https://www.digikey.com/en/products/detail/x/y/1',
          }),
          supplier({ id: 'b', supplierName: 'Mouser', url: 'https://www.mouser.com/ProductDetail/abc' }),
        ]}
      />,
    );
    clickRefresh();
    expect(spies.requestScrape).toHaveBeenCalledTimes(2);
    expect(spies.requestScrape).toHaveBeenCalledWith('https://www.digikey.com/en/products/detail/x/y/1');
    expect(spies.requestScrape).toHaveBeenCalledWith('https://www.mouser.com/ProductDetail/abc');
    expect(screen.getByTestId('supplier-price-refresh')).toHaveTextContent('Refreshing…');
  });

  it('fetches only the pinned price source when one is set', () => {
    render(
      <RefreshPricesButton
        item={item}
        parts={[
          supplier({
            id: 'a',
            supplierName: 'DigiKey',
            url: 'https://www.digikey.com/en/products/detail/x/y/1',
          }),
          supplier({
            id: 'b',
            supplierName: 'Mouser',
            url: 'https://www.mouser.com/ProductDetail/abc',
            isPriceSource: true,
          }),
        ]}
      />,
    );
    clickRefresh();
    expect(spies.requestScrape).toHaveBeenCalledTimes(1);
    expect(spies.requestScrape).toHaveBeenCalledWith('https://www.mouser.com/ProductDetail/abc');
  });

  it('explains when the pinned price source has no fetchable URL', () => {
    render(
      <RefreshPricesButton
        item={item}
        parts={[
          supplier({
            id: 'a',
            supplierName: 'DigiKey',
            url: 'https://www.digikey.com/en/products/detail/x/y/1',
          }),
          supplier({ id: 'b', supplierName: 'Local shop', url: null, isPriceSource: true }),
        ]}
      />,
    );
    clickRefresh();
    expect(spies.requestScrape).not.toHaveBeenCalled();
    expect(spies.show.mock.calls[0][0]).toMatchObject({ heading: 'Price source cannot be fetched' });
  });
});
