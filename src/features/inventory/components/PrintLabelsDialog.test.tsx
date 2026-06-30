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
    const symbology = screen.getByTestId('label-symbology');

    fireEvent.change(symbology, { target: { value: 'none' } });
    screen.getAllByTestId('label-cell').forEach((cell) => {
      expect(cell.querySelector('svg')).toBeNull();
    });

    fireEvent.change(symbology, { target: { value: 'both' } });
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

    fireEvent.change(screen.getByTestId('label-columns'), { target: { value: '4' } });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    expect(usePreferencesStore.getState().labelTemplate.columns).toBe(4);
    expect(save).toBeDisabled();
  });

  it('disables printing and shows a notice when nothing is selected', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={[]} />);
    expect(screen.getByTestId('print-labels-confirm')).toBeDisabled();
    expect(screen.getByText('No items selected.')).toBeTruthy();
  });
});
