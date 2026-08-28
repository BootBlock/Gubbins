import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * Behaviour tests for the {@link ScannerOverlay} Discrete result card's quick actions (the
 * scan→act loop). The scanner's pure seams — payload parsing, the state machine, the batch
 * runner — are covered by `scanner.test.ts`; this pins the *card's* contract: which controls
 * a scanned item offers per tracking mode, and that each routes through the right hook.
 *
 * Per the component-test conventions every hook the overlay touches is mocked (a new hook →
 * extend the mock), the camera/decoder is neutered (`useScanner`) and a scan is driven through
 * the always-available manual-entry seam rather than a faked camera frame. Fixtures are synthetic.
 */

const UUID = '00000000-0000-4000-8000-0000000000ab';

const adjustMutate = vi.fn();
const moveMutateAsync = vi.fn().mockResolvedValue(undefined);
const checkoutMutateAsync = vi.fn().mockResolvedValue(undefined);

// getById drives what the scanned code resolves to; each test sets `scanResult` first.
let scanResult: Item | null = null;
// What a typed/scanned short code resolves to (issue #338) — empty, one item, or ambiguous.
let shortCodeMatches: Item[] = [];
// What an item's stored Barcode field resolves to, and every value the overlay looked up —
// the scanner resolves *any* symbology it captured, not only a valid GTIN (issue #506).
let barcodeMatch: Item | null = null;
const barcodeQueries: string[] = [];
// Every id the overlay asked the repository for. The count is the point: the double-scan guard
// has to sit in *front* of the read, or a label resting in the viewfinder costs one round-trip
// per animation frame (issue #512).
const idQueries: string[] = [];

// The camera/decoder is neutered, but the props the overlay hands the hook are kept so a test can
// play the part of the decode loop — specifically reporting the engine it resolved (issue #678).
const scannerProps = vi.hoisted(() => ({ current: null as { onEngine?: (e: string) => void } | null }));
vi.mock('../useScanner', () => ({
  useScanner: (props: { onEngine?: (e: string) => void }) => {
    scannerProps.current = props;
  },
}));
// The non-visual §6.5 feedback is a browser API surface, but *which* of its two tones fires is
// the whole user-facing point of issue #512 — a rejected re-scan used to sound exactly like a
// code that failed to read — so the stub records the calls rather than swallowing them.
const feedbackCalls = vi.hoisted(() => ({ confirm: 0, repeat: 0 }));
vi.mock('../feedback', () => ({
  ScanFeedback: class {
    prime() {}
    confirm() {
      feedbackCalls.confirm += 1;
    }
    repeat() {
      feedbackCalls.repeat += 1;
    }
    dispose() {}
  },
}));
vi.mock('@/features/contacts/components/CheckoutDialog', () => ({ CheckoutDialog: () => null }));
vi.mock('@/features/contacts/contacts', () => ({
  useCheckoutItem: () => ({ mutateAsync: checkoutMutateAsync, isPending: false }),
}));
vi.mock('@/features/inventory/mutations', () => ({
  useMoveItem: () => ({ mutateAsync: moveMutateAsync, isPending: false }),
  useAdjustQuantity: () => ({ mutate: adjustMutate }),
}));
vi.mock('@/features/inventory/queries', () => ({
  // The card falls back to the scan snapshot until this resolves; leaving it empty keeps the
  // test driving the snapshot from `getById` (below) without a QueryClient.
  useItem: () => ({ data: undefined }),
  useLocations: () => ({
    data: {
      rows: [
        { id: 'loc-2', name: 'Shelf B' },
        // A real-shaped id, so the location arm of the short-code lookup can be exercised.
        { id: '0000000c-0000-4000-8000-00000000000c', name: 'Bin 7' },
      ],
    },
  }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ quantity: (n: number) => String(n) }),
}));
vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getItemRepository: () => ({
    getById: (id: string) => {
      idQueries.push(id);
      return Promise.resolve(scanResult);
    },
    getByBarcode: (value: string) => {
      barcodeQueries.push(value);
      return Promise.resolve(barcodeMatch);
    },
    findByShortCode: () => Promise.resolve(shortCodeMatches),
  }),
}));

// Stub the product-lookup panel: its own network/consent path is unit-tested in the scraping
// feature. Here it just surfaces a button that resolves a fixed product, so the overlay's *wiring*
// (issue #59) — showing the found product and carrying it into the Add-item hand-off — is pinned
// without a real bridge/toast provider tree.
vi.mock('@/features/scraping', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/scraping')>()),
  ProductLookupPanel: ({
    barcode,
    onResult,
  }: {
    barcode: string;
    onResult: (p: {
      gtin: string;
      name: string;
      brand: string | null;
      description: string | null;
      quantity: string | null;
    }) => void;
  }) => (
    <button
      data-testid="stub-product-lookup"
      onClick={() =>
        onResult({
          gtin: barcode,
          name: 'Vitamin C tablets',
          brand: 'Acme',
          description: null,
          quantity: null,
        })
      }
    >
      look up
    </button>
  ),
}));

import { ScannerOverlay } from './ScannerOverlay';

// A valid EAN-13 (check digit correct) so it parses as a GTIN rather than a raw code.
const EAN13 = '4006381333931';

const baseItem: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 10,
  isUnlimited: false,
  serialNo: null,
  mpn: 'NE555P',
  manufacturer: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
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

/** Render the overlay, scan one item via the manual-entry seam, and await its result card. */
async function scan(item: Item, props: Partial<React.ComponentProps<typeof ScannerOverlay>> = {}) {
  scanResult = item;
  render(<ScannerOverlay open onClose={vi.fn()} {...props} />);
  fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value: UUID } });
  fireEvent.click(screen.getByTestId('scanner-manual-submit'));
  await screen.findByTestId('scanner-discrete-result');
}

beforeEach(() => {
  scanResult = null;
  shortCodeMatches = [];
  barcodeMatch = null;
  barcodeQueries.length = 0;
  idQueries.length = 0;
  feedbackCalls.confirm = 0;
  feedbackCalls.repeat = 0;
  adjustMutate.mockReset();
  moveMutateAsync.mockReset().mockResolvedValue(undefined);
  checkoutMutateAsync.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ScannerOverlay — what the decoding engine tells the user', () => {
  /** Report an engine the way the decode loop does, from outside React's own event handling. */
  const reportEngine = async (engine: string) => {
    await act(async () => scannerProps.current?.onEngine?.(engine));
  };

  it('says nothing about the engine while a real one is decoding', async () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);
    await reportEngine('native');
    expect(screen.queryByTestId('scanner-engine-none')).toBeNull();
    expect(screen.queryByTestId('scanner-engine-failed')).toBeNull();
  });

  it('steers to manual entry — and says the engine stopped — when it dies mid-scan (issue #678)', async () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);
    await reportEngine('wasm');
    expect(screen.getByTestId('scanner-engine-wasm')).toBeInTheDocument();

    await reportEngine('failed');

    // Distinct from the `none` copy on purpose: this browser *does* support live scanning, so
    // "isn't supported here" would send the user away from the reload that fixes it.
    const message = screen.getByTestId('scanner-engine-failed');
    expect(message).toHaveTextContent(/stopped working/i);
    expect(message).toHaveTextContent(/reload/i);
    expect(screen.queryByTestId('scanner-engine-wasm')).toBeNull();
    // …and it is announced, not just drawn: it appears long after the surface mounted, so it sits
    // inside the always-mounted live region rather than being inserted as one.
    expect(screen.getByTestId('scanner-notice')).toContainElement(message);
  });
});

describe('ScannerOverlay — "What can I scan?" explainer', () => {
  it('opens the explainer from the header help button and describes both code kinds', async () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);
    // Closed by default — no explainer copy on screen.
    expect(screen.queryByRole('dialog', { name: 'What can I scan?' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'What can I scan?' }));

    const dialog = await screen.findByRole('dialog', { name: 'What can I scan?' });
    // Every accepted code kind and the on-device boundary are spelled out.
    expect(dialog).toHaveTextContent('Gubbins labels');
    expect(dialog).toHaveTextContent('Short codes');
    expect(dialog).toHaveTextContent('Product barcodes');
    // …including the codes that are only a barcode because an item records them (issue #506).
    expect(dialog).toHaveTextContent('Other barcodes');
    expect(dialog).toHaveTextContent(/Looking a product up online is optional/i);

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What can I scan?' })).toBeNull());
  });
});

describe('ScannerOverlay — header layout on a phone (issue #657)', () => {
  /** The header row: the icon, the title, the mode toggle and the two icon buttons. */
  const header = () => screen.getByRole('button', { name: 'Close scanner' }).parentElement!;

  it('wraps the header instead of pushing Close scanner past the right edge', () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);

    // The overlay is `fixed`, so an overflowing header cannot be scrolled back into view — the
    // row has to wrap. jsdom does no layout, so the contract is pinned on the classes that
    // decide it rather than on measured geometry.
    expect(header()).toHaveClass('flex-wrap');
    // The toggle is the item that drops to a second line below `sm`, so the two icon buttons
    // keep the first line to themselves.
    expect(screen.getByTestId('scanner-mode-toggle')).toHaveClass(
      'order-last',
      'basis-full',
      'sm:order-none',
      'sm:basis-auto',
    );
    // …and the title is what gives, rather than either button being squeezed off the row.
    expect(screen.getByText('Scanner')).toHaveClass('min-w-0', 'flex-1', 'truncate');
  });

  it('keeps both header buttons at full size when the row is under pressure', () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close scanner' })).toHaveClass('shrink-0');
    // Help sits inside a Tooltip, whose wrapper span is the actual flex item.
    expect(screen.getByRole('button', { name: 'What can I scan?' }).parentElement).toHaveClass('shrink-0');
  });
});

/**
 * The printed short code (issue #338) — the fallback identifier a label carries for when its QR
 * or barcode is too damaged to scan. Typing it must reach the item, or the printed line is
 * decoration.
 */
describe('ScannerOverlay — printed short code', () => {
  /** Type a value into the manual-entry seam and submit it. */
  const enter = (value: string) => {
    fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value } });
    fireEvent.click(screen.getByTestId('scanner-manual-submit'));
  };

  it('resolves a typed short code to its item', async () => {
    shortCodeMatches = [baseItem];
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('A1B2C3D4');

    const card = await screen.findByTestId('scanner-discrete-result');
    expect(card).toHaveTextContent('NE555 timer');
  });

  it('says a short code is ambiguous rather than opening whichever came back first', async () => {
    shortCodeMatches = [baseItem, { ...baseItem, id: 'item-2', name: 'Other' }];
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('A1B2C3D4');

    await waitFor(() =>
      expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/More than one item/i),
    );
    expect(screen.queryByTestId('scanner-discrete-result')).toBeNull();
  });

  it('jumps to a location whose label carries that short code', async () => {
    const onLocationScanned = vi.fn();
    render(<ScannerOverlay open onClose={vi.fn()} onLocationScanned={onLocationScanned} />);

    enter('0000000C');

    await waitFor(() =>
      expect(onLocationScanned).toHaveBeenCalledWith('0000000c-0000-4000-8000-00000000000c'),
    );
  });

  it('says nothing carries that code when no record does', async () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('DEADBEEF');

    await waitFor(() =>
      expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/Nothing in your inventory/i),
    );
  });
});

/**
 * Any code an item records in its Barcode field resolves — not only a valid GTIN (issue #506).
 * The Add/Edit-item "Scan" button captures every symbology the decoder reads (Code 128, Code 39,
 * ITF, …) verbatim into that field, so a scan of the same physical label has to find the item
 * again; otherwise the app cannot read back what it just wrote.
 */
describe('ScannerOverlay — a stored barcode of any symbology (issue #506)', () => {
  const enter = (value: string) => {
    fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value } });
    fireEvent.click(screen.getByTestId('scanner-manual-submit'));
  };

  it('resolves a Code 128 part label to the item that carries it', async () => {
    barcodeMatch = { ...baseItem, barcode: 'RS-482-9021' };
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('RS-482-9021');

    expect(await screen.findByTestId('scanner-discrete-result')).toHaveTextContent('NE555 timer');
    // Looked up exactly as scanned — the stored value is verbatim, so the match must be too.
    expect(barcodeQueries).toContain('RS-482-9021');
  });

  it('looks a retail barcode up by its canonical GTIN, as before', async () => {
    barcodeMatch = { ...baseItem, barcode: EAN13 };
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter(`  ${EAN13}  `);

    expect(await screen.findByTestId('scanner-discrete-result')).toHaveTextContent('NE555 timer');
    expect(barcodeQueries).toContain(EAN13);
  });

  it('prefers a stored barcode over a printed short code when both could match', async () => {
    // Eight hex characters is both a label's short code and a value an item may record.
    barcodeMatch = baseItem;
    shortCodeMatches = [{ ...baseItem, id: 'item-2', name: 'Short-code item' }];
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('A1B2C3D4');

    expect(await screen.findByTestId('scanner-discrete-result')).toHaveTextContent('NE555 timer');
  });

  it('still names a website link rather than calling it an unknown code', async () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);

    enter('https://example.com/promo');

    await waitFor(() => expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/website link/i));
    expect(screen.queryByTestId('scanner-discrete-result')).toBeNull();
  });
});

describe('ScannerOverlay — unknown barcode product lookup (issue #59)', () => {
  it('offers a lookup for an unknown barcode and carries the found product into Add item', async () => {
    const onCreateFromBarcode = vi.fn();
    render(<ScannerOverlay open onClose={vi.fn()} onCreateFromBarcode={onCreateFromBarcode} />);

    // Scan a valid retail barcode no item carries (getByBarcode → null) via the manual seam.
    fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value: EAN13 } });
    fireEvent.click(screen.getByTestId('scanner-manual-submit'));
    await screen.findByTestId('scanner-gtin-result');

    // The lookup affordance is offered; resolving it shows the found product…
    fireEvent.click(screen.getByTestId('stub-product-lookup'));
    const found = await screen.findByTestId('scanner-gtin-product');
    expect(found).toHaveTextContent('Vitamin C tablets');

    // …and creating from the barcode hands the resolved product to the parent to pre-fill the form.
    fireEvent.click(screen.getByTestId('scanner-create-from-barcode'));
    expect(onCreateFromBarcode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: 'Vitamin C tablets', brand: 'Acme' }),
    );
  });
});

describe('ScannerOverlay — Discrete card ± quantity', () => {
  it('shows the ± stepper for an active DISCRETE item and adjusts by the right delta', async () => {
    await scan(baseItem);
    expect(screen.queryByTestId('scanner-adjust-quantity')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Increase quantity'));
    expect(adjustMutate).toHaveBeenCalledWith({ id: 'item-1', delta: 1 });

    fireEvent.click(screen.getByLabelText('Decrease quantity'));
    expect(adjustMutate).toHaveBeenCalledWith({ id: 'item-1', delta: -1 });
  });

  it.each([
    ['a gauge item', { ...baseItem, trackingMode: 'CONSUMABLE_GAUGE' as const }],
    ['a serialised item', { ...baseItem, trackingMode: 'SERIALISED' as const, serialNo: 1 }],
    ['an untracked item', { ...baseItem, trackingMode: 'UNTRACKED' as const }],
    ['an unlimited source', { ...baseItem, isUnlimited: true }],
  ])('does not show ± for %s', async (_label, item) => {
    await scan(item);
    expect(screen.queryByTestId('scanner-adjust-quantity')).toBeNull();
  });
});

describe('ScannerOverlay — Discrete card Move', () => {
  it('moves the scanned item to the chosen location via useMoveItem', async () => {
    await scan(baseItem);
    fireEvent.click(screen.getByRole('combobox', { name: 'Move to location' }));
    fireEvent.click(screen.getByRole('option', { name: 'Shelf B' }));
    fireEvent.click(screen.getByTestId('scanner-move-single'));

    await waitFor(() => expect(moveMutateAsync).toHaveBeenCalledWith({ id: 'item-1', locationId: 'loc-2' }));
  });
});

describe('ScannerOverlay — Discrete card View details', () => {
  it('hands the scanned item back to onViewItem when wired', async () => {
    const onViewItem = vi.fn();
    await scan(baseItem, { onViewItem });
    fireEvent.click(screen.getByTestId('scanner-view-item'));
    expect(onViewItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }));
  });

  it('hides View details when the parent does not wire the handoff', async () => {
    await scan(baseItem);
    expect(screen.queryByTestId('scanner-view-item')).toBeNull();
  });
});

/**
 * The double-scan guard (§6.4) as a user experiences it in Continuous mode (issue #512).
 *
 * Two things are being pinned, and they are the same defect from either end. A code the guard
 * rejects must not have cost a database read to reject — the decode loop runs every animation
 * frame, so a label left in the viewfinder used to issue one round-trip per frame. And the
 * rejection must be *audible*: batch scanning runs on trusting the confirmation tone, and a
 * repeat that produced no beep, no haptic and no message was indistinguishable from a code
 * that failed to read.
 */
describe('ScannerOverlay — a re-scan in Continuous mode (issue #512)', () => {
  /** Switch to Continuous mode and scan `value` through the always-available manual seam. */
  const enterContinuous = () => {
    render(<ScannerOverlay open onClose={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Continuous/ });
    fireEvent.click(toggle);
    // The queue only exists in Continuous mode, so a toggle that silently did nothing would
    // leave these tests quietly exercising the Discrete path instead.
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  };
  const enter = (value: string) => {
    fireEvent.change(screen.getByTestId('scanner-manual-input'), { target: { value } });
    fireEvent.click(screen.getByTestId('scanner-manual-submit'));
  };

  it('reads the database once and acknowledges the repeat, rather than re-reading in silence', async () => {
    scanResult = baseItem;
    enterContinuous();

    enter(UUID);
    // The confirmation tone is what a user sweeping a shelf is going on; Continuous mode shows
    // no result card, so this is the scan landing.
    await waitFor(() => expect(feedbackCalls.confirm).toBe(1));
    expect(idQueries).toEqual([UUID]);
    expect(screen.queryByTestId('scanner-discrete-result')).toBeNull();

    // The same code again, inside the 2000 ms window — the frame after, as far as the guard is
    // concerned.
    enter(UUID);

    await waitFor(() => expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/already scanned/i));
    // Rejected in front of the read, not behind it.
    expect(idQueries).toEqual([UUID]);
    // …and heard, with the acknowledgement tone rather than a second confirmation.
    expect(feedbackCalls).toEqual({ confirm: 1, repeat: 1 });
  });

  it('acknowledges a second code that names an item already queued', async () => {
    // The label QR resolves the item; its stored barcode resolves the *same* item. Two distinct
    // raw strings, so only the queue's id-keyed guard can catch this one.
    scanResult = baseItem;
    barcodeMatch = baseItem;
    enterContinuous();

    enter(UUID);
    await waitFor(() => expect(feedbackCalls.confirm).toBe(1));

    enter(EAN13);

    await waitFor(() => expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/already scanned/i));
    // The read happened — the raw gate cannot know two strings name one item — but the queue
    // refused it, and that refusal is reported rather than confirmed.
    expect(barcodeQueries).toEqual([EAN13]);
    expect(feedbackCalls).toEqual({ confirm: 1, repeat: 1 });
  });

  it('stays silent for a repeat of a code that resolved to nothing', async () => {
    // Nothing carries it, so the first read already told the user so. A tone on the repeat would
    // claim a scan that never registered.
    scanResult = null;
    enterContinuous();

    enter(UUID);
    await waitFor(() => expect(idQueries).toEqual([UUID]));
    expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/No matching item found/i);

    enter(UUID);

    // Suppressed in front of the read, and heard by nobody.
    await waitFor(() => expect(idQueries).toEqual([UUID]));
    expect(feedbackCalls).toEqual({ confirm: 0, repeat: 0 });
    expect(screen.getByTestId('scanner-notice')).toHaveTextContent(/No matching item found/i);
  });
});
