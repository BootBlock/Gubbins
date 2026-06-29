import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PrintLabelsDialog } from './PrintLabelsDialog';

const ITEMS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Resistor 10k' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'ESP32 board' },
];

afterEach(cleanup);

describe('PrintLabelsDialog — batch QR label sheet (spec §6, Phase 49)', () => {
  it('renders one QR preview cell per selected item', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={ITEMS} />);
    const cells = screen.getAllByTestId('label-cell');
    expect(cells).toHaveLength(2);
    cells.forEach((cell) => expect(cell.querySelector('svg')).not.toBeNull());
    expect(screen.getByText('Resistor 10k')).toBeTruthy();
    expect(screen.getByText('ESP32 board')).toBeTruthy();
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

  it('disables printing and shows a notice when nothing is selected', () => {
    render(<PrintLabelsDialog open onClose={() => {}} items={[]} />);
    expect(screen.getByTestId('print-labels-confirm')).toBeDisabled();
    expect(screen.getByText('No items selected.')).toBeTruthy();
  });
});
