import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Behaviour tests for {@link BarcodeScanDialog} — the Scan-into-the-Barcode-field capture
 * dialog (issue #8). The shared scanning seams it reuses (the camera engine in `useScanner`,
 * the GTIN parse in `scan-payload`/`gtin`, the state machine) are covered by `scanner.test.ts`;
 * this pins the dialog's own contract: which decoded codes it hands back vs. rejects.
 *
 * The camera/decoder is neutered (`useScanner`) and the non-visual feedback stubbed, so a scan
 * is driven through the always-available manual-entry seam rather than a faked camera frame.
 */

// The camera/decoder is neutered, but the props the dialog hands the hook are kept so a test can
// play the part of the decode loop — specifically reporting the engine it resolved (issue #678).
const scannerProps = vi.hoisted(() => ({ current: null as { onEngine?: (e: string) => void } | null }));
vi.mock('../useScanner', () => ({
  useScanner: (props: { onEngine?: (e: string) => void }) => {
    scannerProps.current = props;
  },
}));
vi.mock('../feedback', () => ({
  ScanFeedback: class {
    prime() {}
    confirm() {}
    dispose() {}
  },
}));

import { BarcodeScanDialog } from './BarcodeScanDialog';

afterEach(cleanup);

/** Type a code into the manual-entry seam and submit it, as a no-camera browser would. */
function enter(code: string) {
  fireEvent.change(screen.getByTestId('barcode-scan-manual-input'), { target: { value: code } });
  fireEvent.click(screen.getByTestId('barcode-scan-manual-submit'));
}

describe('BarcodeScanDialog', () => {
  it('hands back a valid retail barcode and closes', () => {
    const onCapture = vi.fn();
    const onClose = vi.fn();
    render(<BarcodeScanDialog open onClose={onClose} onCapture={onCapture} />);

    // A valid EAN-13 (correct mod-10 check digit) is captured verbatim.
    enter('4006381333931');

    expect(onCapture).toHaveBeenCalledWith('4006381333931');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says the engine stopped, and points at manual entry, when it dies mid-scan (issue #678)', async () => {
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={vi.fn()} />);

    await act(async () => scannerProps.current?.onEngine?.('failed'));

    // Distinct from the `none` copy on purpose: this browser *does* support live scanning, so
    // "isn't supported here" would send the user away from the reload that fixes it.
    const message = screen.getByTestId('barcode-scan-engine-failed');
    expect(message).toHaveTextContent(/stopped working/i);
    // Announced, not just drawn: it appears long after the dialog mounted, so it sits inside the
    // always-mounted live region rather than being inserted as one.
    expect(screen.getByTestId('barcode-scan-notice')).toContainElement(message);
  });

  it('rejects a Gubbins label instead of dropping its deep-link into the field', () => {
    const onCapture = vi.fn();
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={onCapture} />);

    // A bare UUID is a Gubbins *item* code, not a product barcode.
    enter('00000000-0000-4000-8000-0000000000ab');

    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByTestId('barcode-scan-notice')).toHaveTextContent(/Gubbins label/i);
  });

  it('offers to open a scanned website link instead of capturing its URL (issue #59)', () => {
    const onCapture = vi.fn();
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={onCapture} />);

    // A marketing QR on the packaging decodes to a link — never a barcode.
    enter('https://wa.me/message/ABCDEFGHIJ?src=qr');

    // The URL is not dropped into the Barcode field; instead the user is offered to open it.
    expect(onCapture).not.toHaveBeenCalled();
    const prompt = screen.getByTestId('barcode-scan-link-prompt');
    expect(prompt).toBeInTheDocument();
    expect(screen.getByTestId('barcode-scan-link-url')).toHaveTextContent(
      'https://wa.me/message/ABCDEFGHIJ?src=qr',
    );
    expect(screen.getByTestId('barcode-scan-link-open')).toBeInTheDocument();

    // Dismissing clears the prompt and captures nothing.
    fireEvent.click(screen.getByTestId('barcode-scan-link-dismiss'));
    expect(screen.queryByTestId('barcode-scan-link-prompt')).toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(<BarcodeScanDialog open={false} onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(screen.queryByTestId('barcode-scan-dialog')).toBeNull();
  });

  it('restores focus to the opener when it closes', () => {
    // The "Scan" button that opens the dialog holds focus beforehand; on close a keyboard user
    // must land back on it, not on <body> (parity with Foundry Modal's focus contract).
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={vi.fn()} />);
    // Focus has moved into the dialog (its aria-labelled container), off the opener.
    expect(document.activeElement).not.toBe(opener);

    rerender(<BarcodeScanDialog open={false} onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  it('pulls a Tab back inside when focus has fallen out of the dialog', () => {
    // The trap's recovery case, not an edge case: whatever held focus can simply unmount (the
    // viewfinder's own controls come and go with the camera state), leaving focus on <body>. The
    // next Tab must land back inside the dialog rather than walking into the page behind it.
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={vi.fn()} />);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(screen.getByTestId('barcode-scan-dialog').contains(document.activeElement)).toBe(true);
  });

  it('leaves a Tab alone while focus sits in a menu portaled outside it (issue #135)', () => {
    // The viewfinder's camera picker is a Foundry Menu, whose panel portals to <body> — outside
    // this dialog's container. A menu owns its own keyboard contract, so the trap must not yank
    // focus off it the moment the user Tabs.
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={vi.fn()} />);
    const panel = document.createElement('div');
    panel.setAttribute('role', 'menu');
    const row = document.createElement('button');
    panel.appendChild(row);
    document.body.appendChild(panel);
    row.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(row);
    panel.remove();
  });
});
