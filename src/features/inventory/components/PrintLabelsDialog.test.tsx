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

    chooseOption('label-sheet-layout', /21 per sheet/);
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    expect(usePreferencesStore.getState().labelTemplate.sheet.columns).toBe(3);
    expect(usePreferencesStore.getState().labelTemplate.sheet.rows).toBe(7);
    expect(save).toBeDisabled();
  });

  it('tiles a chosen sheet stock and reports the size one label works out to (issue #333)', () => {
    const fakeDoc = { write: vi.fn(), close: vi.fn() };
    const fakeWin = { document: fakeDoc, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    expect(screen.getByTestId('label-sheet-layout-cell-size').textContent).toContain('60 × 42 mm');

    chooseOption('label-sheet-layout', /21 per sheet/);
    expect(screen.getByTestId('label-sheet-layout-cell-size').textContent).toContain('63.5 × 38.1 mm');

    fireEvent.click(screen.getByTestId('print-labels-confirm'));
    const written = fakeDoc.write.mock.calls[0]![0] as string;
    expect(written).toContain('grid-template-columns:repeat(3,63.5mm)');
    expect(written).toContain('grid-auto-rows:38.1mm');

    openSpy.mockRestore();
  });

  it('reveals the columns/rows/margin/gutter fields for a custom sheet layout (issue #333)', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    expect(screen.queryByTestId('label-sheet-layout-rows')).toBeNull();

    chooseOption('label-sheet-layout', /Custom/);

    const rows = screen.getByTestId('label-sheet-layout-rows') as HTMLInputElement;
    fireEvent.change(rows, { target: { value: '4' } });
    fireEvent.blur(rows);
    // 6 rows of 42mm become 4 rows of (297 - 20 - 15) / 4.
    expect(screen.getByTestId('label-sheet-layout-cell-size').textContent).toContain('60 × 65.5 mm');

    // An entry the bounds reject is echoed back at the value actually in use — including
    // when the clamp lands on the value the field already held, which changes nothing for
    // a prop-watching effect to notice.
    fireEvent.change(rows, { target: { value: '0' } });
    fireEvent.blur(rows);
    expect(rows.value).toBe('1');
    fireEvent.change(rows, { target: { value: '-3' } });
    fireEvent.blur(rows);
    expect(rows.value).toBe('1');
  });

  it('keeps the chosen stock selected when the cut guide is toggled (issue #333)', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    chooseOption('label-sheet-layout', /21 per sheet/);
    // Named stock comes with the guide off; turning it on is a print choice, not a new layout.
    const outline = screen.getByTestId('label-sheet-layout-outline') as HTMLInputElement;
    expect(outline.checked).toBe(false);
    fireEvent.click(outline);

    expect(outline.checked).toBe(true);
    expect(screen.getByTestId('label-sheet-layout').textContent).toContain('21 per sheet');
    // ...and the six geometry fields stay shut.
    expect(screen.queryByTestId('label-sheet-layout-rows')).toBeNull();
  });

  it('switches to a die-cut size: hides the sheet-layout control and prints an exact-sized sheet', () => {
    const fakeDoc = { write: vi.fn(), close: vi.fn() };
    const fakeWin = { document: fakeDoc, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);

    // Sheet mode shows the layout control...
    expect(screen.queryByTestId('label-sheet-layout')).not.toBeNull();

    chooseOption('label-size', /40 .* 30 mm/);

    // ...die-cut mode replaces it (tiling is meaningless for one-label-per-page).
    expect(screen.queryByTestId('label-sheet-layout')).toBeNull();

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

/** The printed fallback identifier — what still names the item once its code is damaged (#338). */
describe('PrintLabelsDialog — short-code fallback line', () => {
  it('prints each item’s short code by default, and drops it when the toggle is cleared', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    expect(screen.getByText('11111111')).toBeTruthy();
    expect(screen.getByText('22222222')).toBeTruthy();

    fireEvent.click(screen.getByTestId('label-show-short-code'));

    expect(screen.queryByText('11111111')).toBeNull();
    expect(screen.queryByText('22222222')).toBeNull();
    // The names are still there — only the fallback line went.
    expect(screen.getByText('Resistor 10k')).toBeTruthy();
  });

  it('carries the line onto the printed sheet, not just the preview', () => {
    const fakeDoc = { write: vi.fn(), close: vi.fn() };
    const fakeWin = { document: fakeDoc, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    fireEvent.click(screen.getByTestId('print-labels-confirm'));

    expect(fakeDoc.write.mock.calls[0]![0] as string).toContain('11111111');
    openSpy.mockRestore();
  });
});
