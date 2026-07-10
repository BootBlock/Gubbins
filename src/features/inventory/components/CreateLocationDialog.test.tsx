import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { CreateLocationDialog } from './CreateLocationDialog';

const spies = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../mutations', () => ({
  useCreateLocationPath: () => ({ mutate: spies.create, isPending: false }),
}));

afterEach(() => {
  cleanup();
  spies.create.mockReset();
});

const locations: LocationWithCount[] = [];

function renderDialog() {
  render(<CreateLocationDialog open onClose={() => {}} locations={locations} />);
}

describe('CreateLocationDialog', () => {
  it('lands initial focus in the Name field, ready to type', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('tints the Name text with the chosen colour swatch', () => {
    renderDialog();
    const name = screen.getByLabelText('Name');
    expect(name.className).not.toContain('text-loc-teal');
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
    expect(name.className).toContain('text-loc-teal');
  });

  it('offers a Type picker, a Capacity field and a Default toggle', () => {
    renderDialog();
    expect(screen.getByRole('radiogroup', { name: 'Type (optional)' })).toBeTruthy();
    expect(screen.getByLabelText('Capacity (optional)')).toBeTruthy();
    expect(screen.getByLabelText(/default location for new items/i)).toBeTruthy();
  });

  it('gives every field an information badge', () => {
    renderDialog();
    // Name, Parent, Description, Type, Colour, Capacity, Default.
    expect(screen.getAllByLabelText('More information')).toHaveLength(7);
  });

  it('submits the richer metadata', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cabinet A' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Cabinet' }));
    fireEvent.change(screen.getByLabelText('Capacity (optional)'), { target: { value: '20' } });
    fireEvent.click(screen.getByLabelText(/default location for new items/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({
      name: 'Cabinet A',
      kind: 'cabinet',
      capacity: 20,
      isDefault: true,
    });
  });

  it('passes a slash-separated path through verbatim so the repo splits it', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Workshop/Cabinet A/Drawer 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({ name: 'Workshop/Cabinet A/Drawer 3' });
  });

  it('previews the nested levels a path will create', () => {
    renderDialog();
    // No preview for a plain single-level name.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Workshop' } });
    expect(screen.queryByText(/Existing levels are reused/i)).toBeNull();

    // A separator reveals the chain of levels.
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Workshop/Cabinet A/Drawer 3' },
    });
    const preview = screen.getByText(/Existing levels are reused/i);
    expect(preview).toHaveTextContent('Workshop');
    expect(preview).toHaveTextContent('Cabinet A');
    expect(preview).toHaveTextContent('Drawer 3');
  });

  it('previews comma-separated siblings as a fanned-out set', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Garage/Box 1, Box 2, Box 3' },
    });
    const preview = screen.getByText(/Existing levels are reused/i);
    expect(preview).toHaveTextContent('Garage');
    expect(preview).toHaveTextContent('Box 1');
    expect(preview).toHaveTextContent('Box 2');
    expect(preview).toHaveTextContent('Box 3');
    expect(preview).toHaveTextContent(/as siblings/i);
  });

  it('passes a comma-separated sibling list through verbatim for the repo to fan out', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Garage/Box 1, Box 2, Box 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({ name: 'Garage/Box 1, Box 2, Box 3' });
  });

  it('keeps Create disabled when the name is only separators or blank', () => {
    renderDialog();
    const createButton = screen.getByRole('button', { name: 'Create' });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' / \\ ' } });
    expect(createButton).toBeDisabled();
    // A leaf that is only commas has no usable sibling names, so still nothing to create.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' , , ' } });
    expect(createButton).toBeDisabled();
  });
});
