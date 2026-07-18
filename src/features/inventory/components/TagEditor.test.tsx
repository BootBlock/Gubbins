import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TagEditorControl } from './TagEditor';

// The control is presentational, but it reads the dictionary + prefix suggestions directly.
vi.mock('../tags', () => ({
  useTagNames: () => ({
    data: {
      rows: [
        { id: 'a', name: 'fragile' },
        { id: 'b', name: 'on-loan' },
      ],
    },
  }),
  useTagSuggestions: (prefix: string) => ({
    data: prefix.trim().length > 0 ? [{ id: 'c', name: 'project-x' }] : [],
  }),
}));

afterEach(cleanup);

/** Controlled host so committed tags actually land in `names`, like the bound wrappers. */
function Harness({ initial = [] }: { initial?: string[] }) {
  const [names, setNames] = useState<string[]>(initial);
  return <TagEditorControl names={names} onChange={setNames} />;
}

describe('TagEditorControl (issue #84)', () => {
  it('uses a combobox whose listbox is portalled out of the surrounding card', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.click(input);
    const listbox = screen.getByRole('listbox');
    // The clipping bug: a listbox nested in the field's own wrapper is cropped by the card.
    expect(input.parentElement?.contains(listbox)).toBe(false);
    expect(listbox.parentElement).toBe(document.body);
  });

  it('offers the existing dictionary when the field is empty', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['fragile', 'on-loan']);
  });

  it('adds a brand-new freeform tag on Enter', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'brand-new' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('brand-new')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('adds a tag on comma without leaving the separator behind', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'fragile,' } });

    expect(screen.getByText('fragile')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('lands every tag when several comma-separated names arrive at once', () => {
    // Regression: adding them one at a time rebuilt from the same stale `names`, so only
    // the last survived (and each fired its own racing write in the bound wrappers).
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'fragile,heavy,on-loan,' } });

    expect(
      screen.getAllByRole('button', { name: /^Remove tag/ }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remove tag fragile', 'Remove tag heavy', 'Remove tag on-loan']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('keeps text after the final comma in the field', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });
    fireEvent.change(input, { target: { value: 'fragile,heav' } });
    expect(screen.getByRole('button', { name: 'Remove tag fragile' })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('heav');
  });

  it('deduplicates within a single comma-separated batch', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a tag' }), {
      target: { value: 'fragile,FRAGILE,' },
    });
    expect(screen.getAllByRole('button', { name: /^Remove tag/ })).toHaveLength(1);
  });

  it('picks an existing tag from the list', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'on-loan' }));

    expect(screen.getByRole('button', { name: 'Remove tag on-loan' })).toBeTruthy();
  });

  it('will not add the same tag twice, case-insensitively', () => {
    render(<Harness initial={['fragile']} />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'FRAGILE' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getAllByRole('button', { name: /^Remove tag/ })).toHaveLength(1);
  });

  it('drops tags already applied from the suggestion list', () => {
    render(<Harness initial={['fragile']} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['on-loan']);
  });

  it('removes an applied tag', () => {
    render(<Harness initial={['fragile']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag fragile' }));
    expect(screen.queryByRole('button', { name: 'Remove tag fragile' })).toBeNull();
  });
});
