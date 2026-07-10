import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OcrPrefillDialog } from './OcrPrefillDialog';
import type { OcrRecognizerFactory } from './ocr-engine';

// A canned receipt the injected recogniser "reads" — no real WASM worker is loaded.
const RECEIPT = ['Date: 15/03/2024', 'Model: NE555P', 'Serial No: SN-42', 'Total to pay £3.00'].join('\n');

const fakeFactory: OcrRecognizerFactory = async () => ({
  recognize: async () => RECEIPT,
  terminate: async () => {},
});

const failingFactory: OcrRecognizerFactory = async () => ({
  recognize: async () => {
    throw new Error('Failed to fetch worker.min.js');
  },
  terminate: async () => {},
});

function pickPhoto() {
  const file = new File(['image-bytes'], 'receipt.png', { type: 'image/png' });
  const input = screen.getByTestId('ocr-file-input');
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(cleanup);

describe('OcrPrefillDialog', () => {
  it('scans a photo, shows reviewable candidates and applies the chosen fields', async () => {
    const onApply = vi.fn();
    render(<OcrPrefillDialog open onClose={() => {}} onApply={onApply} createRecognizer={fakeFactory} />);

    pickPhoto();

    await screen.findByTestId('ocr-value-price');
    expect(screen.getByTestId('ocr-value-price')).toHaveValue('3');
    expect(screen.getByTestId('ocr-value-mpn')).toHaveValue('NE555P');
    expect(screen.getByTestId('ocr-value-acquired')).toHaveValue('2024-03-15');
    expect(screen.getByTestId('ocr-value-serial')).toHaveValue('SN-42');

    await userEvent.click(screen.getByTestId('ocr-apply'));

    expect(onApply).toHaveBeenCalledWith({
      unitCost: '3',
      acquiredAt: '2024-03-15',
      mpn: 'NE555P',
      serial: 'SN-42',
    });
  });

  it('omits a field the user unticks', async () => {
    const onApply = vi.fn();
    render(<OcrPrefillDialog open onClose={() => {}} onApply={onApply} createRecognizer={fakeFactory} />);

    pickPhoto();
    await screen.findByTestId('ocr-value-price');

    // The price row is first — untick its "apply" checkbox so it is excluded on apply.
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    await userEvent.click(screen.getByTestId('ocr-apply'));

    const prefill = onApply.mock.calls[0][0];
    expect(prefill.unitCost).toBeUndefined();
    expect(prefill.mpn).toBe('NE555P');
  });

  it('surfaces a friendly error when the engine fails to load', async () => {
    render(<OcrPrefillDialog open onClose={() => {}} onApply={() => {}} createRecognizer={failingFactory} />);

    pickPhoto();

    const error = await screen.findByTestId('ocr-error');
    expect(error).toHaveTextContent(/recognition engine/i);
  });
});
