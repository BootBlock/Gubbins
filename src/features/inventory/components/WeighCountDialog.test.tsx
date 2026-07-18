import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';

const spies = vi.hoisted(() => ({ adjust: vi.fn() }));
vi.mock('../mutations', () => ({
  useAdjustQuantity: () => ({ mutate: spies.adjust, isPending: false }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    weight: (grams: number) => `${grams} g`,
    // `Money` is not used here, but the shared mock must expose what any transitively
    // rendered Foundry primitive reads — see the component-test-gotchas note.
    currencyParts: () => ({ prefix: '', suffix: '' }),
  }),
}));

import { WeighCountDialog } from './WeighCountDialog';

/** A bin of tiny M3 screws — the issue #101 worked example: 0.5 g each, 80 recorded. */
const screws = {
  id: 'item-1',
  name: 'M3 screw',
  trackingMode: 'DISCRETE',
  quantity: 80,
  weight: 0.5,
  isActive: true,
  isUnlimited: false,
  gauge: null,
} as unknown as Item;

/** The same item with no unit weight recorded — the degraded case. */
const noWeight = { ...screws, weight: null } as unknown as Item;

const grossField = () => screen.getByLabelText(/Weight on scale/i);
const tareField = () => screen.getByLabelText(/Container weight/i);

beforeEach(() => spies.adjust.mockReset());
afterEach(cleanup);

describe('WeighCountDialog (issue #101)', () => {
  it('turns a scale reading into a count and applies it as a relative delta', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    // 43 g of 0.5 g screws → 86 units; the item has 80 recorded, so the delta is +6.
    fireEvent.change(grossField(), { target: { value: '43' } });

    expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units');
    fireEvent.click(screen.getByTestId('weigh-count-apply'));

    expect(spies.adjust).toHaveBeenCalledTimes(1);
    const [payload] = spies.adjust.mock.calls[0]!;
    expect(payload).toMatchObject({ id: 'item-1', delta: 6 });
    // Only the delta is persisted, and the note records how it was arrived at.
    expect(payload.note).toContain('43 g on scale');
    expect(payload.note).toContain('86 units');
  });

  it('subtracts the container weight before counting', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    // 55 g gross in a 12 g pot → 43 g net → 86 units, exactly as above.
    fireEvent.change(grossField(), { target: { value: '55' } });
    fireEvent.change(tareField(), { target: { value: '12' } });

    expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units');
  });

  it('warns rather than presenting an ambiguous reading as a settled count', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    // 43.25 g is exactly half a screw between 86 and 87 — the count is a guess.
    fireEvent.change(grossField(), { target: { value: '43.25' } });

    expect(screen.getByTestId('weigh-count-confidence-uncertain')).toBeInTheDocument();
    // The user is warned, not blocked — an imprecise scale is still worth counting with.
    expect(screen.getByTestId('weigh-count-apply')).toBeEnabled();
  });

  it('applies a clean reading without any confidence caveat', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    fireEvent.change(grossField(), { target: { value: '43' } });

    expect(screen.queryByTestId('weigh-count-confidence-uncertain')).not.toBeInTheDocument();
    expect(screen.queryByTestId('weigh-count-confidence-close')).not.toBeInTheDocument();
  });

  it('submits the computed value when Enter settles a typed calculation', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    // The weight fields are calculator-enabled: "40+3" settles to 43 on Enter. The field
    // rewrites itself *before* the dialog's own Enter handler runs, so submitting from React
    // state would read a truncated `Number.parseFloat("40+3")` === 40 and apply 80 units
    // (delta 0) instead of 86 (delta +6). Enter must use the settled DOM value.
    const field = grossField();
    fireEvent.change(field, { target: { value: '40+3' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(spies.adjust).toHaveBeenCalledTimes(1);
    expect(spies.adjust.mock.calls[0]![0]).toMatchObject({ delta: 6 });
  });

  it('blames the reading, not an absent container, for a negative weight', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    // No container was entered, so the error must not talk about one.
    fireEvent.change(grossField(), { target: { value: '-5' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/reading cannot be negative/i);
    expect(screen.queryByText(/container weighs more/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
  });

  it('explains an unreadable entry rather than silently greying out Apply', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    fireEvent.change(grossField(), { target: { value: 'abc' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/as a number/i);
    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
  });

  it('rejects a container heavier than the reading instead of counting zero', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    fireEvent.change(grossField(), { target: { value: '5' } });
    fireEvent.change(tareField(), { target: { value: '20' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/container weighs more/i);
    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
    expect(spies.adjust).not.toHaveBeenCalled();
  });

  it('cannot apply a count that matches the recorded quantity', () => {
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    // 40 g of 0.5 g screws → 80 units, which is exactly what is already recorded.
    fireEvent.change(grossField(), { target: { value: '40' } });

    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
  });

  it('explains what to record when the item has no unit weight, offering no form', () => {
    render(<WeighCountDialog item={noWeight} open onClose={() => {}} />);

    expect(screen.getByText(/No unit weight recorded/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Weight on scale/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('weigh-count-apply')).not.toBeInTheDocument();
  });
});
