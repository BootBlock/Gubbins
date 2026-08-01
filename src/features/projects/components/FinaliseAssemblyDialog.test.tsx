import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocationWithCount } from '@/db/repositories';
import type { AssemblyPart } from '../assembly';
import { FinaliseAssemblyDialog } from './FinaliseAssemblyDialog';

// Both project hooks are mocked so the dialog can be exercised without a DB or QueryClient. The
// plan itself is deliberately NOT mocked: the dialog runs the real `planAssemblyDraw` over these
// parts, which is exactly the property under test — the summary is the write's own arithmetic.
const mutate = vi.fn();
const preview = vi.fn();
vi.mock('../projects', () => ({
  useFinaliseAssembly: () => ({ mutate, isPending: false }),
  useAssemblyParts: () => preview(),
}));

function part(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    itemId: 'i1',
    name: 'M3 screw',
    requiredQty: 4,
    onHand: 500,
    trackingMode: 'DISCRETE',
    isUnlimited: false,
    ...overrides,
  };
}

const LOCATIONS = [{ id: 'loc1', name: 'Garage' }] as unknown as readonly LocationWithCount[];

function renderDialog(
  data: AssemblyPart[] | undefined,
  state: Partial<{ isPending: boolean; isError: boolean }> = {},
) {
  preview.mockReturnValue({ data, isPending: false, isError: false, ...state });
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <FinaliseAssemblyDialog open onClose={onClose} projectId="p1" projectName="Lamp" locations={LOCATIONS} />,
  );
  return { onClose, user };
}

/** The summary section's rows, so assertions don't have to reach through the whole dialog. */
function summary() {
  return within(screen.getByRole('region', { name: 'What this takes from stock' }));
}

beforeEach(() => {
  mutate.mockClear();
  preview.mockReset();
});

describe('FinaliseAssemblyDialog (issue #647)', () => {
  it('says how much of each part the build will take before it is taken', () => {
    renderDialog([part(), part({ itemId: 'i2', name: 'Shade', requiredQty: 1, onHand: 1 })]);

    // The default outcome is CONTAINER, so the parts *move* rather than being consumed.
    expect(summary().getByText('Moves 4 of 500')).toBeInTheDocument();
    expect(summary().getByText('Moves the last 1 — the item moves too')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalise' })).toBeEnabled();
  });

  it('switches to consumption wording for the outcomes that consume', async () => {
    const { user } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Permanent consumption/ }));

    expect(summary().getByText('Takes 4 of 500')).toBeInTheDocument();
  });

  it('re-plans when the outcome changes — a gauge is decanted, or carried whole into a box', async () => {
    const glue = part({ name: 'Adhesive', trackingMode: 'CONSUMABLE_GAUGE', requiredQty: 50, onHand: 500 });
    const { user } = renderDialog([glue]);

    expect(summary().getByText('Moves into the container')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Permanent consumption/ }));
    expect(summary().getByText('Takes 50 of 500')).toBeInTheDocument();
  });

  it('names the parts that are short and blocks the button', async () => {
    const { user } = renderDialog([
      part(),
      part({ itemId: 'i2', name: 'Rare chip', requiredQty: 10, onHand: 3 }),
    ]);

    expect(summary().getByText('Needs 10, only 3 on hand')).toBeInTheDocument();
    // A shortfall says what to do about it, not merely that something is wrong.
    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 part hasn’t enough stock for what the bill of materials asks. Add stock or lower the quantity first.',
    );

    // Pressing the button does nothing: the un-undoable write is not merely discouraged, it is
    // unreachable while a part is short.
    const finalise = screen.getByRole('button', { name: 'Finalise' });
    expect(finalise).toBeDisabled();
    await user.click(finalise);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reads an infinite source as drawn but undepleted', () => {
    renderDialog([part({ name: 'Tap water', isUnlimited: true, requiredQty: 1000, onHand: 0 })]);
    expect(summary().getByText('Takes 1,000 — unlimited supply, stock unchanged')).toBeInTheDocument();
  });

  it('finalises with the chosen outcome once the summary is clear', async () => {
    const { user } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Singular object/ }));
    await user.click(screen.getByRole('button', { name: 'Finalise' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({ outcome: 'SINGULAR_OBJECT' });
  });

  it('still allows a finalise when the summary could not be worked out', () => {
    renderDialog(undefined, { isError: true });
    expect(summary().getByText(/Couldn’t work out what this would take/)).toBeInTheDocument();
    // The write re-validates by the same rule, so a failed preview must not be a dead end.
    expect(screen.getByRole('button', { name: 'Finalise' })).toBeEnabled();
  });

  it('holds the button back until the summary has loaded', () => {
    renderDialog(undefined, { isPending: true });
    // Nothing to read yet, so the un-undoable action is not yet offered — and the shortfall
    // warning is not shown for a plan nobody has computed.
    expect(screen.getByRole('button', { name: 'Finalise' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
