import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Behaviour tests for {@link ProductLookupPanel} — the barcode → product enrichment control
 * (issue #59). The pure lookup URL/parse and the online client are covered by their own tests;
 * this pins the panel's own contract: extension path vs. consented direct-online path.
 */

vi.mock('@/features/modules/useFeature', () => ({ useFeature: () => true }));

const show = vi.fn();
vi.mock('@/components/foundry', async (orig) => ({
  ...(await orig<typeof import('@/components/foundry')>()),
  useToast: () => ({ show }),
}));

const bridge = {
  ready: false,
  lookups: {} as Record<string, unknown>,
  requestLookup: vi.fn(() => 'req-1'),
  clearLookup: vi.fn(),
};
vi.mock('../ScrapeBridgeContext', () => ({ useScrapeBridge: () => bridge }));

const online = vi.fn();
vi.mock('../product-lookup-online', () => ({ lookupProductOnline: (...a: unknown[]) => online(...a) }));

const prefState = {
  allowOnlineProductLookup: false,
  setAllowOnlineProductLookup: vi.fn((v: boolean) => {
    prefState.allowOnlineProductLookup = v;
  }),
};
vi.mock('@/state/stores/usePreferencesStore', () => ({
  usePreferencesStore: (sel: (s: typeof prefState) => unknown) => sel(prefState),
}));

import { ProductLookupPanel } from './ProductLookupPanel';

beforeEach(() => {
  bridge.ready = false;
  prefState.allowOnlineProductLookup = false;
  show.mockClear();
  bridge.requestLookup.mockClear();
  online.mockReset();
});
afterEach(cleanup);

describe('ProductLookupPanel (issue #59)', () => {
  it('asks for consent before the first online lookup, and does not fetch until granted', () => {
    render(<ProductLookupPanel barcode="4006381333931" onResult={vi.fn()} />);
    fireEvent.click(screen.getByTestId('product-lookup-submit'));

    // No extension + no prior consent → a consent prompt, and nothing sent yet.
    expect(screen.getByTestId('product-lookup-consent-confirm')).toBeInTheDocument();
    expect(online).not.toHaveBeenCalled();
  });

  it('remembers consent and runs the online lookup on confirm', async () => {
    online.mockResolvedValue({
      ok: true,
      payload: { gtin: '4006381333931', name: 'Test Pen', brand: 'Acme', description: null, quantity: null },
    });
    const onResult = vi.fn();
    render(<ProductLookupPanel barcode="4006381333931" onResult={onResult} />);

    fireEvent.click(screen.getByTestId('product-lookup-submit'));
    fireEvent.click(screen.getByTestId('product-lookup-consent-confirm'));

    expect(prefState.setAllowOnlineProductLookup).toHaveBeenCalledWith(true);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ name: 'Test Pen' })));
    expect(online).toHaveBeenCalledWith('4006381333931');
  });

  it('goes straight online (no prompt) once consent is remembered', async () => {
    prefState.allowOnlineProductLookup = true;
    online.mockResolvedValue({ ok: false, reason: 'No product found.' });
    render(<ProductLookupPanel barcode="4006381333931" onResult={vi.fn()} />);

    fireEvent.click(screen.getByTestId('product-lookup-submit'));

    expect(screen.queryByTestId('product-lookup-consent-confirm')).toBeNull();
    await waitFor(() => expect(online).toHaveBeenCalledWith('4006381333931'));
    // A miss raises a quiet toast rather than throwing.
    await waitFor(() => expect(show).toHaveBeenCalled());
  });

  it('wires the failure toast’s "Enter manually" action to onEnterManually (issue #439)', async () => {
    prefState.allowOnlineProductLookup = true;
    online.mockResolvedValue({ ok: false, reason: 'No product found for barcode 4006381333931.' });
    const onEnterManually = vi.fn();
    render(
      <ProductLookupPanel barcode="4006381333931" onResult={vi.fn()} onEnterManually={onEnterManually} />,
    );

    fireEvent.click(screen.getByTestId('product-lookup-submit'));

    await waitFor(() => expect(show).toHaveBeenCalled());
    const action = show.mock.calls.at(-1)?.[0]?.action;
    expect(action?.label).toBe('Enter manually');
    action?.onClick();
    expect(onEnterManually).toHaveBeenCalledTimes(1);
  });

  it('omits the toast action entirely when no onEnterManually is provided (issue #439)', async () => {
    prefState.allowOnlineProductLookup = true;
    online.mockResolvedValue({ ok: false, reason: 'No product found.' });
    render(<ProductLookupPanel barcode="4006381333931" onResult={vi.fn()} />);

    fireEvent.click(screen.getByTestId('product-lookup-submit'));

    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(show.mock.calls.at(-1)?.[0]?.action).toBeUndefined();
  });

  it('uses the privileged extension path when it is present (no online fetch, no prompt)', () => {
    bridge.ready = true;
    render(<ProductLookupPanel barcode="4006381333931" onResult={vi.fn()} />);

    fireEvent.click(screen.getByTestId('product-lookup-submit'));

    expect(bridge.requestLookup).toHaveBeenCalledWith('4006381333931');
    expect(online).not.toHaveBeenCalled();
    expect(screen.queryByTestId('product-lookup-consent-confirm')).toBeNull();
  });
});
