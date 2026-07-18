import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry';

const mutateMock = vi.fn();
vi.mock('../mutations', () => ({ useAdjustQuantity: () => ({ mutate: mutateMock }) }));
vi.mock('@/lib/useFormatters', () => ({ useFormatters: () => ({ quantity: (n: number) => String(n) }) }));

import { QuantityStepper } from './QuantityStepper';

/** The stepper toasts on a failed adjust, so it needs the provider it has under `<App>`. */
const renderStepper = (quantity: number) =>
  render(<QuantityStepper id="x" quantity={quantity} />, { wrapper: ToastProvider });

/** Every adjust now carries per-call mutation options (the error toast) alongside the variables. */
const expectAdjust = (delta: number) =>
  expect(mutateMock).toHaveBeenCalledWith({ id: 'x', delta }, expect.anything());

beforeEach(() => mutateMock.mockClear());
afterEach(cleanup);

describe('QuantityStepper — direct quantity entry', () => {
  it('opens an input seeded with the current quantity when the number is clicked', () => {
    renderStepper(5);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    expect((screen.getByTestId('quantity-input') as HTMLInputElement).value).toBe('5');
  });

  it('commits the delta to the typed target on Enter', () => {
    renderStepper(5);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expectAdjust(7);
  });

  it('does not mutate when the value is unchanged (no flash on a no-op)', () => {
    renderStepper(5);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('cancels on Escape without mutating', () => {
    renderStepper(5);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mutateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('quantity-input')).toBeNull();
  });

  it('ignores a negative entry', () => {
    renderStepper(5);
    fireEvent.click(screen.getByTestId('quantity-edit'));
    const input = screen.getByTestId('quantity-input');
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('still supports the +/- steppers', () => {
    renderStepper(5);
    fireEvent.click(screen.getByLabelText('Increase quantity'));
    expectAdjust(1);
  });
});

describe('QuantityStepper — a rejected adjust (#302)', () => {
  it('says why the number snapped back instead of reverting silently', () => {
    renderStepper(1);
    fireEvent.click(screen.getByLabelText('Decrease quantity'));

    // Replay what the mutation would do on failure — a lost decrement race, which the
    // repository surfaces as validation rather than a raw constraint message.
    const options = mutateMock.mock.calls[0]![1] as { onError: (e: unknown) => void };
    act(() => options.onError(new Error('Not enough stock left to make that change.')));

    expect(screen.getByText('Couldn’t update the quantity')).toBeInTheDocument();
    expect(screen.getByText('Not enough stock left to make that change.')).toBeInTheDocument();
  });
});
