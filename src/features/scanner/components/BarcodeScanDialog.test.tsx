import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Behaviour tests for {@link BarcodeScanDialog} — the Scan-into-the-Barcode-field capture
 * dialog (issue #8). The shared scanning seams it reuses (the camera engine in `useScanner`,
 * the GTIN parse in `scan-payload`/`gtin`, the state machine) are covered by `scanner.test.ts`;
 * this pins the dialog's own contract: which decoded codes it hands back vs. rejects.
 *
 * The camera/decoder is neutered (`useScanner`) and the non-visual feedback stubbed, so a scan
 * is driven through the always-available manual-entry seam rather than a faked camera frame.
 */

vi.mock('../useScanner', () => ({ useScanner: () => {} }));
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

  it('rejects a Gubbins label instead of dropping its deep-link into the field', () => {
    const onCapture = vi.fn();
    render(<BarcodeScanDialog open onClose={vi.fn()} onCapture={onCapture} />);

    // A bare UUID is a Gubbins *item* code, not a product barcode.
    enter('00000000-0000-4000-8000-0000000000ab');

    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByTestId('barcode-scan-notice')).toHaveTextContent(/Gubbins label/i);
  });

  it('renders nothing when closed', () => {
    render(<BarcodeScanDialog open={false} onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(screen.queryByTestId('barcode-scan-dialog')).toBeNull();
  });
});
