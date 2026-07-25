import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PrintLocationLabelDialog } from './PrintLocationLabelDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_LABEL_TEMPLATE } from '../labels/label-template';

const BIN = { id: '00000000-0000-4000-8000-000000000012', name: 'Bin 3', path: 'Workshop / Shelf B' };

beforeEach(() => usePreferencesStore.setState({ labelTemplate: DEFAULT_LABEL_TEMPLATE }));
afterEach(cleanup);

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
    // The smallest shipped preset has no room for a readable Code 128 at any value.
    chooseOption('loc-label-size', /30 .* 15 mm/);

    expect(screen.getByTestId('loc-label-barcode-too-narrow')).toBeTruthy();
    expect(screen.queryByTestId('loc-label-barcode-shortened')).toBeNull();
    expect(screen.getByTestId('label-cell').querySelector('svg')).toBeNull();
  });
});
