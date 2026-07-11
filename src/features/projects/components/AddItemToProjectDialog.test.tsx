import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/foundry';
import type { Item, ProjectWithCount } from '@/db/repositories';
import { AddItemToProjectDialog } from './AddItemToProjectDialog';

// The add hook is mocked so the dialog can be exercised without a DB/QueryClient; the spy
// immediately drives the success path so onClose/toast fire. `useProjects` returns a fixed
// page so the picker has options.
const mutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const projectsData = vi.hoisted(() => ({ rows: [] as ProjectWithCount[] }));
vi.mock('../projects', () => ({
  useAddItemToProject: () => ({ mutate, isPending: false }),
  useProjects: () => ({ data: { rows: projectsData.rows }, isLoading: false }),
}));
// Router: the empty-state "Go to projects" button navigates, so stub useNavigate.
const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

function makeProject(overrides: Partial<ProjectWithCount> = {}): ProjectWithCount {
  return {
    id: 'p1',
    name: 'Bench PSU',
    description: null,
    icon: null,
    status: 'PLANNING',
    costingMode: 'CURRENT_REPLACEMENT',
    budget: null,
    lineCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const item = { id: 'item-1', name: 'NE555 timer' } as Item;

function renderDialog() {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AddItemToProjectDialog item={item} open onClose={onClose} />
    </ToastProvider>,
  );
  return { onClose, user };
}

beforeEach(() => {
  mutate.mockClear();
  navigate.mockClear();
  projectsData.rows = [makeProject(), makeProject({ id: 'p2', name: 'Guitar pedal', status: 'ACTIVE' })];
});

describe('AddItemToProjectDialog', () => {
  it('adds the item to the chosen project as a BOM line with the given quantity', async () => {
    const { onClose, user } = renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: /Guitar pedal/ }));
    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '4');
    await user.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      projectId: 'p2',
      input: { itemId: 'item-1', requiredQty: 4 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks submission until a project is chosen', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Choose a project/));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows an empty-state (and no form) when there are no projects yet', () => {
    projectsData.rows = [];
    renderDialog();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to project' })).toBeNull();
  });

  it('navigates to the projects list (and closes) from the empty-state button', async () => {
    projectsData.rows = [];
    const { onClose, user } = renderDialog();
    await user.click(screen.getByRole('button', { name: /Go to projects/ }));
    expect(navigate).toHaveBeenCalledWith({ to: '/projects' });
    expect(onClose).toHaveBeenCalled();
  });
});
