import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PrintLabelsDialog } from './PrintLabelsDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_LABEL_TEMPLATE } from '../labels/label-template';

const ITEMS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Resistor 10k', mpn: 'RC0805-10K' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'ESP32 board' },
];

beforeEach(() => usePreferencesStore.setState({ labelTemplate: DEFAULT_LABEL_TEMPLATE }));
afterEach(cleanup);

/** Open a custom Select combobox by its test id and click the option with the given name. */
function chooseOption(testId: string, optionName: string | RegExp) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('PrintLabelsDialog — templated label sheet (spec §6, Phase 49/73)', () => {
  it('renders one preview cell per selected item with a QR by default', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    const cells = screen.getAllByTestId('label-cell');
    expect(cells).toHaveLength(2);
    cells.forEach((cell) => expect(cell.querySelector('svg')).not.toBeNull());
    expect(screen.getByText('Resistor 10k')).toBeTruthy();
    expect(screen.getByText('ESP32 board')).toBeTruthy();
  });

  it('switches symbology: text-only removes the codes, both renders two SVGs per cell', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);

    chooseOption('label-symbology', 'Text only');
    screen.getAllByTestId('label-cell').forEach((cell) => {
      expect(cell.querySelector('svg')).toBeNull();
    });

    chooseOption('label-symbology', 'QR + barcode');
    screen.getAllByTestId('label-cell').forEach((cell) => {
      expect(cell.querySelectorAll('svg')).toHaveLength(2);
    });
  });

  it('labels the print button with the count and prints a self-contained sheet', () => {
    const fakeDoc = { write: vi.fn(), close: vi.fn() };
    const fakeWin = { document: fakeDoc, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);

    const confirm = screen.getByTestId('print-labels-confirm');
    expect(confirm.textContent).toContain('Print 2 labels');

    fireEvent.click(confirm);
    expect(openSpy).toHaveBeenCalledOnce();
    const written = fakeDoc.write.mock.calls[0]![0] as string;
    expect(written.startsWith('<!doctype html>')).toBe(true);
    expect(written).toContain('Resistor 10k');
    expect(written).toContain('ESP32 board');
    expect(fakeWin.print).toHaveBeenCalledOnce();

    openSpy.mockRestore();
  });

  it('persists the working template as the default via "Save as default"', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    const save = screen.getByTestId('label-save-default');
    // Nothing changed yet → nothing to save.
    expect(save).toBeDisabled();

    chooseOption('label-columns', '4');
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    expect(usePreferencesStore.getState().labelTemplate.columns).toBe(4);
    expect(save).toBeDisabled();
  });

  it('switches to a die-cut size: hides the columns control and prints an exact-sized sheet', () => {
    const fakeDoc = { write: vi.fn(), close: vi.fn() };
    const fakeWin = { document: fakeDoc, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);

    // Sheet mode shows the columns control...
    expect(screen.queryByTestId('label-columns')).not.toBeNull();

    chooseOption('label-size', /40 .* 30 mm/);

    // ...die-cut mode replaces it (columns are meaningless for one-label-per-page).
    expect(screen.queryByTestId('label-columns')).toBeNull();

    fireEvent.click(screen.getByTestId('print-labels-confirm'));
    const written = fakeDoc.write.mock.calls[0]![0] as string;
    expect(written).toContain('@page{size:40mm 30mm;margin:0}');

    openSpy.mockRestore();
  });

  it('cautions about the print target for a die-cut size, naming it (issue #337)', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    // The A4 grid prints on ordinary paper, so there is nothing to caution about.
    expect(screen.queryByTestId('labels-die-cut-printer')).toBeNull();

    chooseOption('label-size', /50 .* 80 mm/);

    const notice = screen.getByTestId('labels-die-cut-printer');
    expect(notice.textContent).toContain('50 × 80 mm');
    expect(notice.textContent).toContain('A4 sheet (grid)');

    // ...and it goes away again when the A4 grid is chosen back.
    chooseOption('label-size', /A4 sheet/);
    expect(screen.queryByTestId('labels-die-cut-printer')).toBeNull();
  });

  it('reveals width/height inputs for a custom die-cut size', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    expect(screen.queryByTestId('label-size-width')).toBeNull();

    chooseOption('label-size', /Custom/);

    const width = screen.getByTestId('label-size-width') as HTMLInputElement;
    fireEvent.change(width, { target: { value: '37' } });
    fireEvent.blur(width);
    expect(width.value).toBe('37');
  });

  it('warns when an MPN is too long to print as a readable barcode (issue #331)', () => {
    render(
      <PrintLabelsDialog
        open
        onClose={() => {}}
        items={[{ ...ITEMS[0]!, mpn: 'RC0805-10K-0402-VERY-LONG-PART-NUMBER' }]}
      />,
    );
    // No barcode drawn yet, so nothing to warn about.
    expect(screen.queryByTestId('labels-barcode-shortened')).toBeNull();

    chooseOption('label-symbology', 'Barcode (Code 128)');
    expect(screen.getByTestId('labels-barcode-shortened')).toBeTruthy();
  });

  it('warns when the label is too narrow for any readable barcode (issue #331)', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);

    chooseOption('label-symbology', 'Barcode (Code 128)');
    expect(screen.queryByTestId('labels-barcode-too-narrow')).toBeNull();

    // The smallest shipped preset has no room for the fallback short code, and these items'
    // own values are too long for it as well — so nothing is left to print.
    chooseOption('label-size', /30 .* 15 mm/);

    expect(screen.getByTestId('labels-barcode-too-narrow')).toBeTruthy();
    // Nothing was merely shortened — no label on this sheet can carry a barcode at all.
    expect(screen.queryByTestId('labels-barcode-shortened')).toBeNull();
    screen.getAllByTestId('label-cell').forEach((cell) => {
      expect(cell.querySelector('svg')).toBeNull();
    });
  });

  it('disables printing and shows a notice when nothing is selected', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={[]} />);
    expect(screen.getByTestId('print-labels-confirm')).toBeDisabled();
    expect(screen.getByText('No items selected.')).toBeTruthy();
  });
});
