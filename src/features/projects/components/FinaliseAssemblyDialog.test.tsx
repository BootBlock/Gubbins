import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNASSIGNED_LOCATION_ID, type LocationWithCount } from '@/db/repositories';
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

// The unassigned location is first because it is what the destination field starts on — the
// picker has to be able to show its own default before a choice is made.
const LOCATIONS = [
  { id: UNASSIGNED_LOCATION_ID, name: 'Unassigned' },
  { id: 'loc1', name: 'Garage' },
] as unknown as readonly LocationWithCount[];

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

/**
 * The wiring between the outcome a user picks and the write that runs (issue #492). Finalising is
 * terminal — `PERMANENT_CONSUMPTION` in particular consumes stock — so a default landing on the
 * wrong outcome, or a radio whose value doesn't reach the mutation, would be silent: it
 * type-checks, and the repository tests below it would still pass. These pin the mapping itself,
 * including which extra fields each outcome is allowed to carry.
 */
describe('FinaliseAssemblyDialog — outcome wiring (issue #492)', () => {
  /** Open the destination picker and choose a location by name. */
  const chooseLocation = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole('combobox', { name: 'Place the new item in' }));
    await user.click(screen.getByRole('option', { name }));
  };

  it('starts on Container, the outcome that takes the least away', () => {
    renderDialog([part()]);

    expect(screen.getByRole('radio', { name: /Container/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Singular object/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Permanent consumption/ })).not.toBeChecked();
    // A container becomes a place, so it asks for a location name — not an item name.
    expect(screen.getByLabelText('New location name')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Place the new item in' })).not.toBeInTheDocument();
  });

  it('finalises as a container with the name given, and no destination', async () => {
    const { user } = renderDialog([part()]);
    await user.type(screen.getByLabelText('New location name'), '  Lamp box  ');
    await user.click(screen.getByRole('button', { name: 'Finalise' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    // A container *is* the new place, so it never carries one of its own.
    expect(mutate.mock.calls[0]![0]).toEqual({ outcome: 'CONTAINER', resultName: 'Lamp box' });
  });

  it('finalises as a singular object with the name and the destination chosen', async () => {
    const { user } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Singular object/ }));
    // The new thing is an item, so the field asks for an item name and a shelf to put it on.
    await user.type(screen.getByLabelText('New item name'), 'Lamp');
    await chooseLocation(user, 'Garage');
    await user.click(screen.getByRole('button', { name: 'Finalise' }));

    expect(mutate.mock.calls[0]![0]).toEqual({
      outcome: 'SINGULAR_OBJECT',
      resultName: 'Lamp',
      resultLocationId: 'loc1',
    });
  });

  it('places a singular object in Unassigned when no destination is picked', async () => {
    const { user } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Singular object/ }));
    await user.click(screen.getByRole('button', { name: 'Finalise' }));

    // An untouched picker still sends its own default rather than nothing at all, so the new item
    // lands somewhere findable. An unnamed result is left to the repository to name.
    expect(mutate.mock.calls[0]![0]).toEqual({
      outcome: 'SINGULAR_OBJECT',
      resultLocationId: UNASSIGNED_LOCATION_ID,
    });
  });

  it('finalises as permanent consumption with nothing but the outcome', async () => {
    const { user } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Permanent consumption/ }));

    // Nothing survives the build, so there is nothing to name and nowhere to put it.
    expect(screen.queryByLabelText('New location name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New item name')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Place the new item in' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finalise' }));
    expect(mutate.mock.calls[0]![0]).toEqual({ outcome: 'PERMANENT_CONSUMPTION' });
  });

  it('carries a name over between the two outcomes that take one', async () => {
    const { user } = renderDialog([part()]);
    await user.type(screen.getByLabelText('New location name'), 'Lamp');
    await user.click(screen.getByRole('radio', { name: /Singular object/ }));

    // The same box, relabelled — a name typed before the outcome changed is not silently dropped.
    expect(screen.getByLabelText('New item name')).toHaveValue('Lamp');
  });

  it('forgets the choice when the dialog is cancelled', async () => {
    const { user, onClose } = renderDialog([part()]);
    await user.click(screen.getByRole('radio', { name: /Permanent consumption/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    // The next opening starts fresh: a stale consuming outcome must not be one click from running.
    expect(screen.getByRole('radio', { name: /Container/ })).toBeChecked();
    expect(screen.getByLabelText('New location name')).toHaveValue('');
  });
});
