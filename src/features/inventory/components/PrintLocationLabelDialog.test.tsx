import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { blockPrinting } from '@/test/print-capture';
import { PrintLocationLabelDialog } from './PrintLocationLabelDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_LABEL_TEMPLATE } from '../labels/label-template';

const BIN = { id: '00000000-0000-4000-8000-000000000012', name: 'Bin 3', path: 'Workshop / Shelf B' };

beforeEach(() => usePreferencesStore.setState({ labelTemplate: DEFAULT_LABEL_TEMPLATE }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Open a custom Select combobox by its test id and click the option with the given name. */
function chooseOption(testId: string, optionName: string | RegExp) {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('PrintLocationLabelDialog — barcode readability (issue #331)', () => {
  it('prints a short name as its own barcode, with no warning', () => {
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    chooseOption('loc-label-symbology', 'Barcode (Code 128)');

    // The name is short enough to encode legibly, so it is what the barcode carries.
    expect(screen.getByTestId('label-cell').querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('loc-label-barcode-shortened')).toBeNull();
    expect(screen.queryByTestId('loc-label-barcode-too-narrow')).toBeNull();
  });

  it('warns and falls back to a short code when the name is too long to print readably', () => {
    render(
      <PrintLocationLabelDialog
        open
        onClose={() => {}}
        location={{ ...BIN, name: 'Workshop shelf B, third drawer' }}
      />,
    );
    // The QR carries the location's link regardless of name length — nothing to warn about.
    expect(screen.queryByTestId('loc-label-barcode-shortened')).toBeNull();

    chooseOption('loc-label-symbology', 'Barcode (Code 128)');

    expect(screen.getByTestId('loc-label-barcode-shortened')).toBeTruthy();
    // A barcode still prints — just a short code rather than the unreadable name.
    expect(screen.getByTestId('label-cell').querySelector('svg')).not.toBeNull();
  });

  it('warns and drops the barcode entirely on a label too narrow to carry one', () => {
    // A short name still fits the smallest preset; it is the long one that has nowhere to
    // go, because the fallback short code needs more width than 30 mm leaves.
    render(
      <PrintLocationLabelDialog
        open
        onClose={() => {}}
        location={{ ...BIN, name: 'Workshop shelf B third drawer' }}
      />,
    );
    chooseOption('loc-label-symbology', 'Barcode (Code 128)');
    // The smallest shipped preset has no room for the fallback short code.
    chooseOption('loc-label-size', /30 .* 15 mm/);

    expect(screen.getByTestId('loc-label-barcode-too-narrow')).toBeTruthy();
    expect(screen.queryByTestId('loc-label-barcode-shortened')).toBeNull();
    expect(screen.getByTestId('label-cell').querySelector('svg')).toBeNull();
  });

  it('warns when the label is too small for a scannable QR (issue #330)', () => {
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    // The default A4 grid has plenty of room for the deep-link's code.
    expect(screen.queryByTestId('loc-label-qr-too-small')).toBeNull();

    // 30 × 15 mm with a name line leaves the QR a few millimetres for 45 modules.
    chooseOption('loc-label-size', /30 .* 15 mm/);
    expect(screen.getByTestId('loc-label-qr-too-small')).toBeTruthy();
    // Still drawn: a QR's payload cannot be shortened the way a barcode's value can, and it
    // is the only code on the label — so the warning is the whole remedy.
    expect(screen.getByTestId('label-cell').querySelector('svg')).not.toBeNull();

    chooseOption('loc-label-size', /A4 sheet/);
    expect(screen.queryByTestId('loc-label-qr-too-small')).toBeNull();
  });
});

describe('PrintLocationLabelDialog — die-cut print target (issue #337)', () => {
  it('cautions about the printer for a die-cut size, naming it', () => {
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    // The A4 grid prints on ordinary paper, so there is nothing to caution about.
    expect(screen.queryByTestId('loc-label-die-cut-printer')).toBeNull();

    chooseOption('loc-label-size', /40 .* 30 mm/);

    const notice = screen.getByTestId('loc-label-die-cut-printer');
    expect(notice.textContent).toContain('40 × 30 mm');
    expect(notice.textContent).toContain('A4 sheet (grid)');

    chooseOption('loc-label-size', /A4 sheet/);
    expect(screen.queryByTestId('loc-label-die-cut-printer')).toBeNull();
  });
});

describe('PrintLocationLabelDialog — sheet print scale (issue #514)', () => {
  it('cautions about the print scale once a die-cut sheet stock is chosen', () => {
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    // Plain paper is cut by hand along the guides, so a scaled print costs nothing but paper.
    expect(screen.queryByTestId('loc-label-sheet-printer')).toBeNull();

    chooseOption('loc-label-sheet-layout', /21 per sheet/);
    expect(screen.getByTestId('loc-label-sheet-printer').textContent).toContain('100%');

    // A die-cut size is one label per page, so its own notice takes over.
    chooseOption('loc-label-size', /40 .* 30 mm/);
    expect(screen.queryByTestId('loc-label-sheet-printer')).toBeNull();
    expect(screen.getByTestId('loc-label-die-cut-printer')).toBeTruthy();
  });
});

/** The printed fallback identifier — what still names the bin once its code is damaged (#338). */
describe('PrintLocationLabelDialog — short-code fallback line', () => {
  it('prints the location’s short code by default, and drops it when the toggle is cleared', () => {
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    expect(screen.getByText('00000000')).toBeTruthy();

    fireEvent.click(screen.getByTestId('loc-label-show-short-code'));

    expect(screen.queryByText('00000000')).toBeNull();
    // The name is still on the label — only the fallback line went. (It also appears as the
    // dialog's own description, hence `getAllByText`.)
    expect(screen.getAllByText('Bin 3').length).toBeGreaterThan(0);
  });

  it('seeds the toggle from the saved default template', () => {
    usePreferencesStore.setState({
      labelTemplate: { ...DEFAULT_LABEL_TEMPLATE, showShortId: false },
    });
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    expect(screen.queryByText('00000000')).toBeNull();
  });
});

describe('PrintLocationLabelDialog — a print the browser refuses (issue #510)', () => {
  it('says so rather than leaving the button looking broken', async () => {
    blockPrinting();
    render(<PrintLocationLabelDialog open onClose={() => {}} location={BIN} />);
    expect(screen.queryByTestId('loc-label-print-blocked')).toBeNull();

    fireEvent.click(screen.getByTestId('print-location-label-confirm'));

    const banner = await screen.findByTestId('loc-label-print-blocked');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('blocked the print window');
  });
});
