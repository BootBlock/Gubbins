import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { CreateLocationDialog } from './CreateLocationDialog';

const spies = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../mutations', () => ({
  useCreateLocation: () => ({ mutate: spies.create, isPending: false }),
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
});
