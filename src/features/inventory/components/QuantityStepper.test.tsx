import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const mutateMock = vi.fn();
vi.mock('../mutations', () => ({ useAdjustQuantity: () => ({ mutate: mutateMock }) }));
vi.mock('@/lib/useFormatters', () => ({ useFormatters: () => ({ quantity: (n: number) => String(n) }) }));

import { QuantityStepper } from './QuantityStepper';

beforeEach(() => mutateMock.mockClear());
afterEach(cleanup);

describe('QuantityStepper — direct quantity entry', () => {
  it('opens an input seeded with the current quantity when the number is clicked', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    expect((screen.getByTestId('quantity-input') as HTMLInputElement).value).toBe('5');
  });

  it('commits the delta to the typed target on Enter', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutateMock).toHaveBeenCalledWith({ id: 'x', delta: 7 });
  });

  it('does not mutate when the value is unchanged (no flash on a no-op)', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('cancels on Escape without mutating', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mutateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('quantity-input')).toBeNull();
  });

  it('ignores a negative entry', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('still supports the +/- steppers', () => {
    render(<QuantityStepper id="x" quantity={5} />);
    fireEvent.click(screen.getByLabelText('Increase quantity'));
    expect(mutateMock).toHaveBeenCalledWith({ id: 'x', delta: 1 });
  });
});
