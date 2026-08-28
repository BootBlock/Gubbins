import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { blockPrinting, capturePrintedHtml } from '@/test/print-capture';
import { QrCodeDialog } from './QrCodeDialog';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_LABEL_TEMPLATE } from '../labels/label-template';

/** A fake `NDEFReader` whose write stays pending so the dialog shows its "writing" state. */
function installFakeReader() {
  const write = vi.fn(() => new Promise<void>(() => {}));
  class FakeReader {
    write = write;
    scan = vi.fn(async () => {});
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }
  (globalThis as { NDEFReader?: unknown }).NDEFReader = FakeReader;
  return write;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
  useModulesStore.setState({ intent: {} });
});

const props = {
  open: true,
  onClose: () => {},
  itemId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  itemName: 'Widget',
  itemMpn: null,
};

describe('QrCodeDialog — write to NFC tag (issue #71)', () => {
  it('offers "Write to tag" and arms a url write when NFC is available', () => {
    const write = installFakeReader();
    render(<QrCodeDialog {...props} />);

    const button = screen.getByTestId('nfc-write');
    expect(button).toHaveTextContent('Write to tag');

    fireEvent.click(button);

    // The item's deep-link is written as a single url record.
    expect(write).toHaveBeenCalledTimes(1);
    const [message] = write.mock.calls[0]!;
    expect(message.records[0].recordType).toBe('url');
    expect(message.records[0].data).toContain(props.itemId);

    // The status region announces the tap prompt and the button is now disabled.
    expect(screen.getByTestId('nfc-write-status')).toHaveTextContent(/hold a blank tag/i);
    expect(button).toBeDisabled();
  });

  it('hides the write affordance where Web NFC is unsupported', () => {
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('nfc-write')).toBeNull();
  });

  it('hides the write affordance when the NFC capability is turned off', () => {
    installFakeReader();
    useModulesStore.setState({ intent: { nfc: false } });
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('nfc-write')).toBeNull();
  });
});

/** Switch the symbology combobox to the named option. */
function chooseSymbology(optionName: string) {
  fireEvent.click(screen.getByTestId('qr-symbology'));
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('QrCodeDialog — barcode readability (issue #331)', () => {
  it('encodes a workable MPN verbatim, with no notice', () => {
    render(<QrCodeDialog {...props} itemMpn="RC0805-10K" />);
    chooseSymbology('Barcode (Code 128)');

    expect(screen.getByTestId('item-barcode')).toBeTruthy();
    expect(screen.queryByTestId('item-barcode-shortened')).toBeNull();
  });

  it('falls back to a short item code, and says so, when the MPN is too long to print readably', () => {
    render(<QrCodeDialog {...props} itemMpn={'X'.repeat(60)} />);
    // The QR is unaffected by MPN length, so nothing is said until a barcode is asked for.
    expect(screen.queryByTestId('item-barcode-shortened')).toBeNull();

    chooseSymbology('Barcode (Code 128)');

    expect(screen.getByTestId('item-barcode')).toBeTruthy();
    expect(screen.getByTestId('item-barcode-shortened')).toHaveTextContent(/short item code/i);
  });
});

/** The printed fallback identifier on the single-item label (issue #338). */
describe('QrCodeDialog — short code', () => {
  it('shows the item’s short code, and prints it on the label', async () => {
    const printed = capturePrintedHtml();

    render(<QrCodeDialog {...props} />);
    expect(screen.getByTestId('item-short-code').textContent).toBe('A1B2C3D4');

    fireEvent.click(screen.getByRole('button', { name: 'Print label' }));
    await waitFor(() => expect(printed).toHaveLength(1));
    expect(printed[0]!).toContain('A1B2C3D4');
  });

  it('does not repeat the code when the barcode already prints it beneath the bars', () => {
    // A too-long MPN falls back to the short id, which this dialog always prints as the
    // barcode's human-readable text — so the separate line would say nothing new.
    render(
      <QrCodeDialog
        {...props}
        itemMpn={'RC0805-10K-0402-VERY-LONG-PART-NUMBER-THAT-CANNOT-POSSIBLY-FIT-ON-A-LABEL'}
      />,
    );
    fireEvent.click(screen.getByTestId('qr-symbology'));
    fireEvent.click(screen.getByRole('option', { name: 'Barcode (Code 128)' }));

    expect(screen.getByTestId('item-barcode-shortened')).toBeTruthy();
    expect(screen.queryByTestId('item-short-code')).toBeNull();
  });

  it('omits the code when the label template turns it off', () => {
    usePreferencesStore.setState({
      labelTemplate: { ...DEFAULT_LABEL_TEMPLATE, showShortId: false },
    });
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('item-short-code')).toBeNull();
    usePreferencesStore.setState({ labelTemplate: DEFAULT_LABEL_TEMPLATE });
  });
});

describe('QrCodeDialog — Download SVG (issue #646)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('a[download]').forEach((a) => a.remove());
  });

  it('clicks an attached anchor and defers the revoke, so the file arrives outside Chromium', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let attachedAtClick = false;
    let filenameAtClick: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      attachedAtClick = this.isConnected;
      filenameAtClick = this.download;
    });

    render(<QrCodeDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download SVG' }));

    // A detached anchor's synthetic click is ignored outside Chromium, and revoking on the
    // click's own tick races Firefox's asynchronous blob fetch (Bugzilla 1282407).
    expect(attachedAtClick).toBe(true);
    expect(filenameAtClick).toBe('widget-qr.svg');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

describe('QrCodeDialog — a print the browser refuses (issue #510)', () => {
  it('says so rather than leaving the button looking broken', async () => {
    blockPrinting();
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('qr-print-blocked')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Print label' }));

    const banner = await screen.findByTestId('qr-print-blocked');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('blocked the print window');
  });
});
