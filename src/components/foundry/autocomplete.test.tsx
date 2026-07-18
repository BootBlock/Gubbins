import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Autocomplete, AutocompleteField } from './autocomplete';
import { filterSuggestions } from './autocomplete-filter';

afterEach(cleanup);

const MAKERS = ['Texas Instruments', 'TDK', 'TE Connectivity', 'Nexperia', 'Yageo'];

/** A minimal controlled host so typing updates `value` like a real form binding. */
function Harness({ suggestions = MAKERS, initial = '' }: { suggestions?: string[]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AutocompleteField label="Manufacturer" value={value} onChange={setValue} suggestions={suggestions} />
  );
}

describe('filterSuggestions — type-ahead ranking (pure)', () => {
  it('ranks prefix matches above substring matches, keeping input order within a group', () => {
    // "ne": a prefix hit (Nexperia) ranks above a mid-word hit (TE Con**ne**ctivity), even
    // though the substring match appears first in the input. Input order is kept within a group.
    expect(filterSuggestions(['TE Connectivity', 'Nexperia', 'Yageo'], 'ne')).toEqual([
      'Nexperia',
      'TE Connectivity',
    ]);
  });

  it('is case-insensitive and matches substrings when no prefix wins', () => {
    // "onn" only appears inside "TE Connectivity".
    expect(filterSuggestions(MAKERS, 'ONN')).toEqual(['TE Connectivity']);
  });

  it('drops a suggestion identical to the query (nothing left to complete)', () => {
    expect(filterSuggestions(['USD', 'EUR'], 'USD')).toEqual([]);
  });

  it('returns the whole list (capped) for an empty query', () => {
    expect(filterSuggestions(MAKERS, '')).toEqual(MAKERS);
    expect(filterSuggestions(MAKERS, '   ', 2)).toEqual(MAKERS.slice(0, 2));
  });
});

describe('Autocomplete — editable combobox (WAI-ARIA APG)', () => {
  it('exposes the combobox roles and stays collapsed until interaction', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens a filtered list as the user types and lets any free text through', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'te' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // The listbox is portalled to document.body so it escapes any scroll-clip ancestor —
    // it must NOT be nested inside the field's wrapper.
    const listbox = screen.getByRole('listbox');
    expect(listbox.closest('[role="combobox"]')).toBeNull();
    expect(input.parentElement?.contains(listbox)).toBe(false);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Texas Instruments', 'TE Connectivity']);
    // Free text that matches nothing is still accepted (value is not constrained to the list).
    fireEvent.change(input, { target: { value: 'Acme Widgets' } });
    expect(input.value).toBe('Acme Widgets');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects the highlighted option with the keyboard (ArrowDown, Enter)', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'te' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight first: "Texas Instruments"
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('Texas Instruments');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects a suggestion on pointer choice', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'y' } });
    fireEvent.mouseDown(screen.getByText('Yageo'));
    expect(input.value).toBe('Yageo');
  });

  it('closes on Escape without clearing the typed value', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'te' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('te');
  });

  it('toggles the list from the chevron affordance', () => {
    render(<Harness initial="" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    // The chevron is aria-hidden; grab it as the sole button in the field.
    const chevron = document.querySelector('button')!;
    fireEvent.mouseDown(chevron);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
  });
});

describe('AutocompleteField — labelled wrapper', () => {
  it('names the control via an explicit label and announces an error', () => {
    render(
      <AutocompleteField
        label="Unit"
        value=""
        onChange={() => {}}
        suggestions={[]}
        error="Required for consumables."
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Unit' });
    const alert = screen.getByRole('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.textContent).toBe('Required for consumables.');
  });

  it('renders a hint badge without polluting the control’s accessible name', () => {
    render(
      <AutocompleteField
        label="Supplier"
        value=""
        onChange={() => {}}
        suggestions={[]}
        hint="Who sells it."
      />,
    );
    expect(screen.getByRole('img', { name: 'More information' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Supplier' })).toBeTruthy();
  });

  it('forwards inputRef to the underlying input', () => {
    let el: HTMLInputElement | null = null;
    render(
      <AutocompleteField
        label="Supplier"
        value=""
        onChange={() => {}}
        suggestions={[]}
        inputRef={(node) => {
          el = node;
        }}
      />,
    );
    expect(el).toBeInstanceOf(HTMLInputElement);
  });
});

describe('Autocomplete — creatable mode (onCommit, issue #84)', () => {
  /** Controlled host mirroring the tag editor: each committed value is consumed. */
  function CreatableHarness({ onCommit }: { onCommit: (value: string) => void }) {
    const [value, setValue] = useState('');
    return (
      <Autocomplete
        aria-label="Add a tag"
        value={value}
        onChange={setValue}
        suggestions={MAKERS}
        onCommit={(v) => {
          setValue('');
          onCommit(v);
        }}
      />
    );
  }

  it('commits the typed free text on Enter when nothing is highlighted', () => {
    const committed: string[] = [];
    render(<CreatableHarness onCommit={(v) => committed.push(v)} />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'brand-new-tag' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Free text is accepted verbatim — the value is never constrained to the list.
    expect(committed).toEqual(['brand-new-tag']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('commits the highlighted suggestion on Enter rather than the typed text', () => {
    const committed: string[] = [];
    render(<CreatableHarness onCommit={(v) => committed.push(v)} />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'td' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(committed).toEqual(['TDK']);
  });

  it('ignores Enter on an empty field', () => {
    const committed: string[] = [];
    render(<CreatableHarness onCommit={(v) => committed.push(v)} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Add a tag' }), { key: 'Enter' });
    expect(committed).toEqual([]);
  });

  it('leaves Enter alone for a plain (non-creatable) field, so forms still submit', () => {
    // No onCommit: Enter with nothing highlighted must NOT be swallowed.
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'Anything' } });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
