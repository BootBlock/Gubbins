import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/foundry';
import type { Project } from '@/db/repositories';
import { EditProjectDialog } from './EditProjectDialog';

// The update hook is mocked so the dialog can be exercised without a DB/QueryClient; the
// spy immediately drives the success path so onClose/toast fire.
const mutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
vi.mock('../projects', () => ({
  useUpdateProject: () => ({ mutate, isPending: false }),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Bench PSU',
    description: 'A supply',
    icon: 'Rocket',
    status: 'PLANNING',
    costingMode: 'CURRENT_REPLACEMENT',
    budget: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderDialog(project = makeProject()) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <EditProjectDialog open onClose={onClose} project={project} />
    </ToastProvider>,
  );
  return { onClose, user };
}

beforeEach(() => mutate.mockClear());

describe('EditProjectDialog', () => {
  it('seeds the form from the current project', () => {
    renderDialog();
    expect(screen.getByLabelText('Name')).toHaveValue('Bench PSU');
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('A supply');
    // The icon field is labelled "Icon (optional)" and previews the current glyph by its
    // humanised name.
    expect(screen.getByRole('button', { name: 'Icon (optional)' })).toBeInTheDocument();
    expect(screen.getByText('Rocket')).toBeInTheDocument();
  });

  it('saves an edited name, keeping the other fields', async () => {
    const { onClose, user } = renderDialog();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Bench PSU v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      id: 'p1',
      input: {
        name: 'Bench PSU v2',
        icon: 'Rocket',
        status: 'PLANNING',
        costingMode: 'CURRENT_REPLACEMENT',
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('clears the icon back to none', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Remove icon' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0]).toMatchObject({ id: 'p1', input: { icon: null } });
  });

  it('changes the lifecycle status', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0]).toMatchObject({ id: 'p1', input: { status: 'ACTIVE' } });
  });

  it('re-seeds from the live project when reopened', () => {
    const onClose = vi.fn();
    const project = makeProject({ name: 'First' });
    const { rerender } = render(
      <ToastProvider>
        <EditProjectDialog open onClose={onClose} project={project} />
      </ToastProvider>,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('First');

    // Close, then reopen against an updated project — the form must show the live value,
    // not a stale draft from the previous session.
    rerender(
      <ToastProvider>
        <EditProjectDialog open={false} onClose={onClose} project={project} />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <EditProjectDialog open onClose={onClose} project={makeProject({ name: 'Renamed' })} />
      </ToastProvider>,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Renamed');
  });

  it('does not discard in-progress edits when the project refetches while open', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const project = makeProject({ name: 'Original' });
    const { rerender } = render(
      <ToastProvider>
        <EditProjectDialog open onClose={onClose} project={project} />
      </ToastProvider>,
    );
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'My draft');

    // Simulate a background refetch while the dialog stays open: a new project object with
    // the same id arrives. The user's draft must survive (no reset while already open).
    rerender(
      <ToastProvider>
        <EditProjectDialog open onClose={onClose} project={makeProject({ name: 'Original' })} />
      </ToastProvider>,
    );

    expect(screen.getByLabelText('Name')).toHaveValue('My draft');
  });
});
