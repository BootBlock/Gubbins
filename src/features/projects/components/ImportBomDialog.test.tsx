import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
const HTML_BOM =
  '<table><tr><th>Reference</th><th>MPN</th><th>Quantity</th></tr>' +
  '<tr><td>R1</td><td>RC0805FR-0710KL</td><td>2</td></tr></table>';

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
    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: BOM } });
    await user.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    expect(createMutate.mock.calls[0]![0]).toMatchObject({ project: { name: 'Bench PSU' } });
    expect(onCreated).toHaveBeenCalledWith('new-project-1');
    expect(onClose).toHaveBeenCalled();
    // The existing-project path is never taken in new-project mode.
    expect(importMutate).not.toHaveBeenCalled();
  });

  it('keeps the create button disabled until a name is entered', async () => {
    render(<ImportBomDialog open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: BOM } });
    expect(screen.getByRole('button', { name: /Create project/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Bench PSU' } });
    expect(screen.getByRole('button', { name: /Create project/ })).toBeEnabled();
  });
});

describe('ImportBomDialog — existing-project mode (projectId given)', () => {
  it('imports into the existing project without a name field', async () => {
    const user = userEvent.setup();
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);

    expect(screen.queryByLabelText('Project name')).toBeNull();

    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: BOM } });
    await user.click(screen.getByRole('button', { name: /Import/ }));

    await waitFor(() => expect(importMutate).toHaveBeenCalledTimes(1));
    expect(createMutate).not.toHaveBeenCalled();
  });
});

describe('ImportBomDialog — quantities the file stated (issue #350)', () => {
  const ZERO_AND_BAD_BOM = ['Reference,MPN,Quantity', 'R1,RC0805FR-0710KL,0', 'R2,NE555P,notanumber'].join(
    '\n',
  );

  it('previews a zero quantity as zero and lists the row it could not read', async () => {
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);
    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: ZERO_AND_BAD_BOM } });

    // The "not needed this build" line is previewed as written, not promoted to one unit.
    expect(await screen.findByText('RC0805FR-0710KL')).toBeInTheDocument();
    expect(screen.getByText('1 line ready')).toBeInTheDocument();

    const problems = screen.getByTestId('bom-import-problems');
    expect(problems).toHaveTextContent('1 row wasn’t imported');
    expect(problems).toHaveTextContent(/Row 2 \(R2\).*notanumber.*isn’t a quantity/);
  });

  it('imports only the rows it could read', async () => {
    const user = userEvent.setup();
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);
    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: ZERO_AND_BAD_BOM } });

    await user.click(screen.getByRole('button', { name: /Import/ }));

    await waitFor(() => expect(importMutate).toHaveBeenCalledTimes(1));
    expect(importMutate.mock.calls[0]![0]).toEqual([
      { designator: 'R1', mpn: 'RC0805FR-0710KL', manufacturer: null, description: null, requiredQty: 0 },
    ]);
  });

  it('shows no notice when every row was usable', () => {
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);
    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: BOM } });
    expect(screen.queryByTestId('bom-import-problems')).toBeNull();
  });
});

describe('ImportBomDialog — flexible source formats', () => {
  it('parses and previews a pasted HTML-table BOM', async () => {
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);
    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: HTML_BOM } });
    // The MPN cell appears in the preview table once the HTML table is recognised.
    expect(await screen.findByText('RC0805FR-0710KL')).toBeInTheDocument();
  });

  it('re-parses when the format override changes (CSV forced as JSON fails)', async () => {
    const user = userEvent.setup();
    render(<ImportBomDialog open onClose={vi.fn()} projectId="p1" />);

    fireEvent.change(screen.getByLabelText('BOM text'), { target: { value: BOM } });
    expect(await screen.findByText('RC0805FR-0710KL')).toBeInTheDocument();

    // Force JSON: the CSV text is no longer parseable, so the preview clears and an error shows.
    await user.click(screen.getByRole('combobox', { name: 'Interpret as' }));
    await user.click(screen.getByRole('option', { name: 'JSON' }));

    await waitFor(() => expect(screen.queryByText('RC0805FR-0710KL')).toBeNull());
    expect(screen.getByText(/No recognisable BOM columns/i)).toBeInTheDocument();
  });
});
