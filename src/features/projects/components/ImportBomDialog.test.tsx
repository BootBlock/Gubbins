import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportBomDialog } from './ImportBomDialog';

// Both import hooks are mocked so the dialog can be exercised without a DB/QueryClient. Each
// spy immediately drives its success path so the onSuccess callbacks (summary / onCreated) fire.
const importMutate = vi.fn((_lines: unknown, opts?: { onSuccess?: (r: unknown) => void }) =>
  opts?.onSuccess?.({ added: 1, matched: 1 }),
);
const createMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: (r: unknown) => void }) =>
  opts?.onSuccess?.({ projectId: 'new-project-1', added: 1, matched: 0 }),
);
vi.mock('../projects', () => ({
  useImportBom: () => ({ mutate: importMutate, isPending: false }),
  useCreateProjectFromBom: () => ({ mutate: createMutate, isPending: false }),
}));

const BOM = 'Reference,Value,Quantity,MPN\nR1,10k,2,RC0805FR-0710KL';

beforeEach(() => {
  importMutate.mockClear();
  createMutate.mockClear();
});

describe('ImportBomDialog — new-project mode (no projectId)', () => {
  it('creates a project from the pasted BOM and reports the new id', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<ImportBomDialog open onClose={onClose} onCreated={onCreated} />);

    await user.type(screen.getByLabelText('Project name'), 'Bench PSU');
    await user.type(screen.getByLabelText('BOM CSV text'), BOM);
    await user.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).toMatchObject({ project: { name: 'Bench PSU' } });
    expect(onCreated).toHaveBeenCalledWith('new-project-1');
    expect(onClose).toHaveBeenCalled();
    // The existing-project path is never taken in new-project mode.
    expect(importMutate).not.toHaveBeenCalled();
  });

  it('keeps the create button disabled until a name is entered', async () => {
    const user = userEvent.setup();
    render(<ImportBomDialog open onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('BOM CSV text'), BOM);
    expect(screen.getByRole('button', { name: /Create project/ })).toBeDisabled();

    await user.type(screen.getByLabelText('Project name'), 'Bench PSU');
    expect(screen.getByRole('button', { name: /Create project/ })).toBeEnabled();
  });
});

describe('ImportBomDialog — existing-project mode (projectId given)', () => {
  it('imports into the existing project without a name field', async () => {
    const user = userEvent.setup();
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);

    expect(screen.queryByLabelText('Project name')).toBeNull();

    await user.type(screen.getByLabelText('BOM CSV text'), BOM);
    await user.click(screen.getByRole('button', { name: /Import/ }));

    await waitFor(() => expect(importMutate).toHaveBeenCalledTimes(1));
    expect(createMutate).not.toHaveBeenCalled();
  });
});
