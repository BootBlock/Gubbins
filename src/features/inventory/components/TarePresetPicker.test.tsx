import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behaviour tests for the {@link TarePresetPicker}'s manage-your-own-containers paths
 * (issue #377): a saved container can be edited and deleted, a built-in one cannot, and a
 * delete is confirmed before it happens rather than firing straight from the row.
 *
 * Per the component-test conventions every hook the picker uses is mocked, and the mutation
 * doubles honour the `mutate(vars, { onSuccess })` shape the component calls them with.
 */

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
  presets: [] as unknown[],
  /** Which mutation is sitting in its failed state, so the error copy can be asserted. */
  failed: { create: false, update: false, delete: false },
}));

vi.mock('../tare-preset-queries', () => ({
  useTarePresets: () => ({ presets: h.presets, isLoading: false }),
  useCreateTarePreset: () => ({
    mutate: h.createMutate,
    reset: vi.fn(),
    isPending: false,
    isError: h.failed.create,
  }),
  useUpdateTarePreset: () => ({
    mutate: h.updateMutate,
    reset: vi.fn(),
    isPending: false,
    isError: h.failed.update,
  }),
  useDeleteTarePreset: () => ({
    mutate: h.deleteMutate,
    reset: vi.fn(),
    isPending: false,
    isError: h.failed.delete,
  }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ weight: (grams: number) => `${grams} g` }),
}));

import { TarePresetPicker } from './TarePresetPicker';

/** A container the user weighed themselves — the only kind that can be edited or deleted. */
const savedJar = {
  id: 'preset-saved-1',
  name: 'Flour jar',
  kind: 'JAR' as const,
  tareGrams: 420,
  saved: true,
};

/** A published figure from the built-in catalogue — not the user's to change. */
const builtInSpool = {
  id: 'builtin-spool-1',
  name: 'Cardboard spool',
  kind: 'SPOOL' as const,
  tareGrams: 190,
};

function setup(presets: unknown[] = [savedJar, builtInSpool]) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  h.presets = presets;
  h.failed = { create: false, update: false, delete: false };
  h.createMutate.mockReset();
  h.updateMutate.mockReset().mockImplementation((_vars, opts) => opts?.onSuccess?.(savedJar));
  h.deleteMutate.mockReset().mockImplementation((_id, opts) => opts?.onSuccess?.());
  render(<TarePresetPicker open onClose={onClose} onSelect={onSelect} />);
  return { onClose, onSelect, user };
}

afterEach(cleanup);

describe('TarePresetPicker — which containers offer edit and delete', () => {
  it('offers edit and delete on a container the user saved', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Edit Flour jar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Flour jar' })).toBeInTheDocument();
  });

  it('offers neither on a built-in container', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Edit Cardboard spool' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Cardboard spool' })).not.toBeInTheDocument();
  });
});

describe('TarePresetPicker — editing a saved container', () => {
  it('opens the form pre-filled with what the container holds', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));

    expect(screen.getByRole('heading', { name: 'Edit container' })).toBeInTheDocument();
    expect(screen.getByTestId('tare-preset-name')).toHaveValue('Flour jar');
    expect(screen.getByTestId('tare-preset-weight')).toHaveValue('420');
    expect(screen.getByTestId('tare-preset-save')).toHaveTextContent('Save changes');
  });

  it('saves the edit against the container being edited', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));

    const name = screen.getByTestId('tare-preset-name');
    await user.clear(name);
    await user.type(name, 'Big flour jar');
    const weight = screen.getByTestId('tare-preset-weight');
    await user.clear(weight);
    await user.type(weight, '430');
    await user.click(screen.getByTestId('tare-preset-save'));

    await waitFor(() => expect(h.updateMutate).toHaveBeenCalledTimes(1));
    expect(h.updateMutate.mock.calls[0]?.[0]).toEqual({
      id: 'preset-saved-1',
      input: { name: 'Big flour jar', kind: 'JAR', tareGrams: 430 },
    });
    // Creating is never confused with editing.
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it('closes the form but leaves the picker open, since an edit is not a choice', async () => {
    const { user, onSelect, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));
    await user.click(screen.getByTestId('tare-preset-save'));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Edit container' })).not.toBeInTheDocument(),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the measured weight exactly when only the name is corrected', async () => {
    // The field shows the weight rounded to 4dp, so a naive round-trip would write 420.0001
    // back over a jar the user actually weighed at 420.00007 g — renaming must not re-weigh it.
    const preciseJar = { ...savedJar, tareGrams: 420.00007 };
    const { user } = setup([preciseJar]);
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));

    const name = screen.getByTestId('tare-preset-name');
    await user.clear(name);
    await user.type(name, 'Big flour jar');
    await user.click(screen.getByTestId('tare-preset-save'));

    await waitFor(() => expect(h.updateMutate).toHaveBeenCalledTimes(1));
    expect(h.updateMutate.mock.calls[0]?.[0]).toEqual({
      id: 'preset-saved-1',
      input: { name: 'Big flour jar', kind: 'JAR', tareGrams: 420.00007 },
    });
  });

  it('refuses to save an edit that blanks the name', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));
    await user.clear(screen.getByTestId('tare-preset-name'));

    expect(screen.getByTestId('tare-preset-save')).toBeDisabled();
    expect(h.updateMutate).not.toHaveBeenCalled();
  });
});

describe('TarePresetPicker — deleting a saved container', () => {
  it('asks before deleting rather than removing it on the spot', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete Flour jar' }));

    expect(await screen.findByText('Delete container?')).toBeInTheDocument();
    expect(h.deleteMutate).not.toHaveBeenCalled();
  });

  it('deletes the container once the confirmation is accepted', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete Flour jar' }));
    await user.click(await screen.findByTestId('confirm-delete-tare-preset'));

    await waitFor(() => expect(h.deleteMutate).toHaveBeenCalledTimes(1));
    expect(h.deleteMutate.mock.calls[0]?.[0]).toBe('preset-saved-1');
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete Flour jar' }));
    await screen.findByTestId('confirm-delete-tare-preset');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('confirm-delete-tare-preset')).not.toBeInTheDocument());
    expect(h.deleteMutate).not.toHaveBeenCalled();
  });
});

/**
 * A write here can genuinely fail — the repository refuses growth-writes while storage is
 * locked — and the worst outcome is the button appearing to do nothing (issue #314). These
 * pin the failed state down to *words the user can read*: an announced message naming which
 * write failed, with the form still holding what they typed so a retry is a click, not a retype.
 *
 * Each test drives the mutation into `isError` and then renders the form over it, rather than
 * pressing the button and waiting for a rejection: these are hook-level mocks, so a click
 * cannot flip a mutation's state the way the real hook does. What is being pinned is the
 * component's rendering of a failed mutation, which is where the silence in #314 lived.
 */
describe('TarePresetPicker — when a write is in its failed state', () => {
  it('says the save failed, and keeps what was typed', async () => {
    const { user } = setup();
    h.failed.create = true;
    await user.click(screen.getByTestId('tare-preset-add'));
    await user.type(screen.getByTestId('tare-preset-name'), 'Bean tin');
    await user.type(screen.getByTestId('tare-preset-weight'), '55');
    await user.click(screen.getByTestId('tare-preset-save'));

    const alert = await screen.findByTestId('tare-preset-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('That container could not be saved.');
    // The button stayed live — a failed save must not strand the user with a dead control.
    expect(h.createMutate).toHaveBeenCalledTimes(1);
    // The form keeps the user's input, so retrying costs a click rather than a retype.
    expect(screen.getByTestId('tare-preset-name')).toHaveValue('Bean tin');
    expect(screen.getByTestId('tare-preset-weight')).toHaveValue('55');
  });

  it('names the edit, not the save, when changing a container failed', async () => {
    const { user } = setup();
    h.failed.update = true;
    await user.click(screen.getByRole('button', { name: 'Edit Flour jar' }));

    // The two failures share one slot, so an inverted branch here would tell the user the
    // wrong thing went wrong.
    const alert = await screen.findByTestId('tare-preset-error');
    expect(alert).toHaveTextContent('That container could not be changed.');
    expect(screen.getByTestId('tare-preset-name')).toHaveValue('Flour jar');
  });

  it('says the delete failed inside the confirmation dialog', async () => {
    const { user } = setup();
    h.failed.delete = true;
    await user.click(screen.getByRole('button', { name: 'Delete Flour jar' }));

    // Beside the confirm button, not in the picker behind it — the message has to land where
    // the user is looking.
    const alert = await screen.findByTestId('tare-preset-delete-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('That container could not be deleted.');
    expect(screen.getByTestId('confirm-delete-tare-preset')).toBeInTheDocument();
  });
});
