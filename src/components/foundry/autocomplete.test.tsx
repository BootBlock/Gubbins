import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Autocomplete, AutocompleteField } from './autocomplete';
import { browseStartIndex, filterSuggestions, indexOfValue } from './autocomplete-filter';

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

describe('browseStartIndex — where a browse starts (pure)', () => {
  it('finds the held value case-insensitively, ignoring surrounding space', () => {
    expect(browseStartIndex(MAKERS, '  tdk ')).toBe(1);
  });

  it('falls back to the option the type-ahead would have ranked first', () => {
    // The currency field's case: it holds `USD`, the list offers `USD — US Dollar`. Without
    // the fallback a browse would start at the top of the catalogue — one Enter away from
    // swapping the value for an unrelated currency.
    expect(browseStartIndex(['GBP — British Pound', 'USD — US Dollar'], 'USD')).toBe(1);
  });

  it('reports -1 for a value that matches nothing, and for an empty field', () => {
    expect(browseStartIndex(MAKERS, 'Acme Widgets')).toBe(-1);
    expect(browseStartIndex(MAKERS, '   ')).toBe(-1);
  });

  it('offers indexOfValue for the exact-only case, which takes no near match', () => {
    expect(indexOfValue(MAKERS, 'tdk')).toBe(1);
    expect(indexOfValue(MAKERS, 'TD')).toBe(-1);
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

  it('leaves Escape to the enclosing dialog when no list is on screen', () => {
    // Text that matches nothing leaves the control "open" with an empty popup. Escape there
    // must reach the Modal, not be swallowed closing something the user cannot see.
    render(<Harness initial="" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'Acme Widgets' } });
    expect(screen.queryByRole('listbox')).toBeNull();

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
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

  it('browses the whole list from the chevron even when the field already holds a value (#414)', () => {
    // The reported bug: a field holding an exact match filtered down to nothing — the one
    // suggestion left is dropped as having nothing to complete — so the chevron looked dead.
    render(<Harness initial="TDK" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.mouseDown(document.querySelector('button')!);

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(MAKERS);
    // The browse starts on the value already held, so a long list opens showing it.
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('TDK');
  });

  it('browses past maxOptions, which caps the type-ahead only', () => {
    render(
      <AutocompleteField
        label="Manufacturer"
        value=""
        onChange={() => {}}
        suggestions={MAKERS}
        maxOptions={2}
      />,
    );
    fireEvent.mouseDown(document.querySelector('button')!);
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
  });

  it('starts filtering only once the user types into an open browse', () => {
    render(<Harness initial="T" />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.mouseDown(document.querySelector('button')!);
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);

    // Typing narrows against everything the field then holds, not just the new character.
    fireEvent.change(input, { target: { value: 'TD' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['TDK']);
  });

  it('browses on ArrowDown from a closed list, landing on the held value', () => {
    render(<Harness initial="Yageo" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Yageo');
  });

  it('lands on the first option when ArrowDown opens on a value that fits nothing', () => {
    render(<Harness initial="Acme Widgets" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.getByRole('option', { selected: true }).textContent).toBe(MAKERS[0]);
  });

  it('browses again after a chevron close, rather than staying filtered', () => {
    render(<Harness initial="" />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'TD' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);

    const chevron = document.querySelector('button')!;
    fireEvent.mouseDown(chevron); // close the filtered list
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.mouseDown(chevron); // reopen — browsing, not filtering
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
    expect(input.value).toBe('TD');
  });

  it('browses from a click on the input even after text that matched nothing', () => {
    // Typing leaves the list "open" with nothing to show; the click that follows must still
    // browse rather than read as another dead control.
    render(<Harness initial="" />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'Acme Widgets' } });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
  });

  it('opens from the chevron on the first press after text that matched nothing', () => {
    render(<Harness initial="" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.change(input, { target: { value: 'Acme Widgets' } });
    fireEvent.mouseDown(document.querySelector('button')!);
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves Enter free to submit after a click that only placed the caret', () => {
    // A click into a filled field is caret placement, so it highlights nothing — otherwise
    // Enter would re-pick the value it already holds instead of submitting the form.
    render(<Harness initial="TDK" />);
    const input = screen.getByRole('combobox', { name: 'Manufacturer' });
    fireEvent.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
    expect(screen.queryByRole('option', { selected: true })).toBeNull();

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('starts a browse on the closest option when the value is only a prefix of it', () => {
    // The currency field's shape: the value is a bare code, the options are code + name.
    render(
      <AutocompleteField
        label="Currency"
        value="USD"
        onChange={() => {}}
        suggestions={['GBP — British Pound', 'USD — US Dollar']}
      />,
    );
    fireEvent.mouseDown(document.querySelector('button')!);
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('USD — US Dollar');
  });

  it('offers a prefiltered list verbatim, however little it looks like the typed text', () => {
    // A server-searched list has already been narrowed — possibly by rules this control cannot
    // reproduce (folded punctuation, synonyms). Re-filtering it literally would throw matches
    // away, so `prefiltered` shows exactly what was handed over, capped and no more.
    render(
      <AutocompleteField
        label="Supplier"
        value="RS Comp"
        onChange={() => {}}
        suggestions={['RS-Components', 'R.S. Components Ltd']}
        prefiltered
      />,
    );
    fireEvent.mouseDown(document.querySelector('button')!);

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'RS-Components',
      'R.S. Components Ltd',
    ]);
  });

  it('still caps a prefiltered list at maxOptions', () => {
    render(
      <AutocompleteField
        label="Supplier"
        value=""
        onChange={() => {}}
        suggestions={MAKERS}
        prefiltered
        maxOptions={2}
      />,
    );
    fireEvent.mouseDown(document.querySelector('button')!);

    expect(screen.getAllByRole('option')).toHaveLength(2);
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

  it('does not arm a near match when the chevron browses (the typed text is a candidate)', () => {
    // Typing `Y` then browsing must not pre-arm `Yageo`: Enter would create a tag the user
    // never asked for. Only the field's own value may be highlighted in creatable mode.
    const committed: string[] = [];
    render(<CreatableHarness onCommit={(v) => committed.push(v)} />);
    const input = screen.getByRole('combobox', { name: 'Add a tag' });

    fireEvent.change(input, { target: { value: 'Y' } });
    fireEvent.keyDown(input, { key: 'Escape' }); // dismiss the type-ahead the keystroke opened
    fireEvent.mouseDown(document.querySelector('button')!);
    expect(screen.getAllByRole('option')).toHaveLength(MAKERS.length);
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(committed).toEqual(['Y']);
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
