import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BarcodeField } from './BarcodeField';

vi.mock('@/features/modules/useFeature', () => ({ useFeature: () => true }));

afterEach(cleanup);

/** Render with the value held in a parent, so typing behaves as it does in the real forms. */
function renderField(initial = '') {
  const onScan = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <BarcodeField
        value={value}
        onChange={setValue}
        onScan={onScan}
        inputTestId="barcode"
        scanTestId="barcode-scan"
      />
    );
  }
  render(<Harness />);
  return { input: screen.getByTestId('barcode'), onScan };
}

/** Type `value` and leave the field, which is when the advisory check runs. */
function typeAndBlur(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('BarcodeField — typed-entry check (issue #344)', () => {
  it('warns about a transposed digit once the field is left', () => {
    const { input } = renderField();
    typeAndBlur(input, '4006381333930'); // …930 for …931
    const warning = screen.getByText(/check digit/i);
    // Advisory, not a rejection: described to the control but never marked invalid.
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(warning.id);
  });

  it('warns about a digit run of no recognised barcode width', () => {
    const { input } = renderField();
    typeAndBlur(input, '12345');
    expect(screen.getByText(/8, 12, 13 or 14 digits/i)).toBeTruthy();
  });

  it('stays quiet for a valid barcode', () => {
    const { input } = renderField();
    typeAndBlur(input, '4006381333931');
    expect(screen.queryByText(/check digit/i)).toBeNull();
  });

  it('stays quiet for a non-numeric code, which is a legitimate entry', () => {
    const { input } = renderField();
    typeAndBlur(input, 'SHELF-A12');
    expect(screen.queryByText(/check digit/i)).toBeNull();
    expect(screen.queryByText(/digits/i)).toBeNull();
  });

  it('says nothing while a barcode is still being typed', () => {
    // A part-typed EAN-13 passes through 12 digits — a real GTIN width whose check digit
    // almost certainly fails — so judging per keystroke would flash a bogus warning.
    const { input } = renderField();
    fireEvent.change(input, { target: { value: '400638133393' } });
    expect(screen.queryByText(/check digit/i)).toBeNull();
  });

  it('clears a shown warning as soon as the user resumes typing', () => {
    const { input } = renderField();
    typeAndBlur(input, '4006381333930');
    expect(screen.getByText(/check digit/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: '400638133393' } });
    expect(screen.queryByText(/check digit/i)).toBeNull();
  });

  it('warns immediately about a barcode that was already stored', () => {
    // The editing case: nothing to wait for, and it is the mistake the user could not
    // otherwise discover — the item silently stops resolving on a scan.
    renderField('4006381333930');
    expect(screen.getByText(/check digit/i)).toBeTruthy();
  });

  it('warns about a barcode that arrives without being typed', () => {
    // The editor switching to another item, or a camera capture landing in the field: the
    // value is finished the moment it arrives, so it is judged without waiting for a blur.
    const { rerender } = render(
      <BarcodeField
        value=""
        onChange={vi.fn()}
        onScan={vi.fn()}
        inputTestId="barcode"
        scanTestId="barcode-scan"
      />,
    );
    expect(screen.queryByText(/check digit/i)).toBeNull();
    rerender(
      <BarcodeField
        value="4006381333930"
        onChange={vi.fn()}
        onScan={vi.fn()}
        inputTestId="barcode"
        scanTestId="barcode-scan"
      />,
    );
    expect(screen.getByText(/check digit/i)).toBeTruthy();
  });

  it('forwards the blur to the form library', () => {
    const onBlur = vi.fn();
    render(
      <BarcodeField
        value=""
        onChange={vi.fn()}
        onBlur={onBlur}
        onScan={vi.fn()}
        inputTestId="barcode"
        scanTestId="barcode-scan"
      />,
    );
    fireEvent.blur(screen.getByTestId('barcode'));
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('opens the scanner from the Scan button', () => {
    const { onScan } = renderField();
    fireEvent.click(screen.getByTestId('barcode-scan'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
