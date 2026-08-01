import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Select, type SelectOption } from './select';
import { SELECT_FILTER_THRESHOLD, SELECT_WINDOW_THRESHOLD } from './select-options';

afterEach(cleanup);

/** `count` bins named "Bin 0", "Bin 1", … — a stand-in for a bin-level location hierarchy. */
const bins = (count: number): SelectOption[] =>
  Array.from({ length: count }, (_, index) => ({ value: `bin-${index}`, label: `Bin ${index}` }));

function renderSelect(options: SelectOption[], value = '', onChange = vi.fn()) {
  render(
    <>
      <span id="loc-label">Location</span>
      <Select aria-labelledby="loc-label" value={value} onChange={onChange} options={options} />
    </>,
  );
  return onChange;
}

const combobox = () => screen.getByRole('combobox', { name: 'Location' });
const openList = () => fireEvent.click(combobox());
const typeFilter = (text: string) => fireEvent.change(combobox(), { target: { value: text } });

describe('Select — pointer cost of an open list', () => {
  it('does not move the active option (or its announcement) as the pointer crosses the list', () => {
    renderSelect(bins(4));
    const combo = combobox();
    combo.focus();
    fireEvent.keyDown(combo, { key: 'ArrowDown' }); // open, active = Bin 0
    const activeBefore = combo.getAttribute('aria-activedescendant');
    expect(activeBefore).toBe(screen.getByRole('option', { name: 'Bin 0' }).id);

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Bin 3' }));

    // Hover is a CSS state only: `aria-activedescendant` stays put, so nothing re-renders and a
    // screen reader is not dragged down the list behind the mouse.
    expect(combo.getAttribute('aria-activedescendant')).toBe(activeBefore);
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('still selects with the pointer', () => {
    const onChange = renderSelect(bins(4));
    openList();
    fireEvent.click(screen.getByRole('option', { name: 'Bin 2' }));
    expect(onChange).toHaveBeenCalledWith('bin-2');
  });
});

describe('Select — filtering a long list', () => {
  const longList = bins(SELECT_FILTER_THRESHOLD);

  it('leaves a short list as a plain listbox, with no filter field', () => {
    renderSelect(bins(SELECT_FILTER_THRESHOLD - 1), 'bin-1');
    openList();
    expect(combobox().tagName).toBe('DIV');
    expect(screen.queryByPlaceholderText('Type to filter…')).toBeNull();
  });

  it('turns the trigger into the filter field once the list is long enough to need one', () => {
    renderSelect(longList, 'bin-1');
    expect(combobox().tagName).toBe('DIV');
    expect(combobox()).toHaveTextContent('Bin 1');

    openList();
    // Exactly one combobox still — the role (and the label naming it) moved onto the input.
    const combo = combobox();
    expect(combo.tagName).toBe('INPUT');
    expect(combo).toHaveAttribute('placeholder', 'Type to filter…');
    expect(combo).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(combo);
  });

  it('narrows the list as the user types, and chooses from what is left', () => {
    const onChange = renderSelect(longList);
    openList();
    typeFilter('bin 1');

    const listbox = screen.getByRole('listbox', { name: 'Location' });
    // "Bin 1", "Bin 10" and "Bin 11" of the twelve.
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Bin 1', 'Bin 10', 'Bin 11']);
    fireEvent.click(screen.getByRole('option', { name: 'Bin 11' }));
    expect(onChange).toHaveBeenCalledWith('bin-11');
  });

  it('says so when nothing matches, and refuses to commit an absent choice', () => {
    const onChange = renderSelect(longList);
    openList();
    typeFilter('no such bin');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching options')).toBeTruthy();
    expect(combobox().getAttribute('aria-activedescendant')).toBeNull();

    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('keeps a pinned command row reachable even when the query matches no option', () => {
    renderSelect([...longList, { value: '__create__', label: '＋ New location…', kind: 'action' }]);
    openList();
    typeFilter('no such bin');
    expect(screen.getByRole('option', { name: '＋ New location…' })).toBeTruthy();
    // …and it is still reported as no match, so the command row never reads as one.
    expect(screen.getByText('No matching options')).toBeTruthy();
  });

  it('leaves the caret keys to the filter field: Space types, Home/End do not jump the list', () => {
    renderSelect(longList);
    openList();
    const activeAtTop = combobox().getAttribute('aria-activedescendant');

    fireEvent.keyDown(combobox(), { key: 'End' });
    expect(combobox().getAttribute('aria-activedescendant')).toBe(activeAtTop);

    // Space would otherwise choose the active option instead of typing a word break.
    fireEvent.keyDown(combobox(), { key: ' ' });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('clears the filter on Escape, and only closes on a second Escape', () => {
    const onChange = renderSelect(longList);
    openList();
    typeFilter('bin 11');
    expect(screen.getAllByRole('option')).toHaveLength(1);

    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.getAllByRole('option')).toHaveLength(SELECT_FILTER_THRESHOLD);

    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // Focus is handed back to the trigger, which is the combobox again.
    expect(document.activeElement).toBe(combobox());
  });

  it('recovers a usable active option after a query that matched nothing', () => {
    const onChange = renderSelect(longList);
    openList();
    typeFilter('no such bin');
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' }); // nowhere to go — the list is empty
    typeFilter('');

    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('bin-0');
  });

  it('closes from the pointer via the chevron, without disturbing the filter field first', () => {
    renderSelect(longList);
    openList();
    const chevron = combobox().parentElement?.querySelector('button');
    expect(chevron).toBeTruthy();
    fireEvent.mouseDown(chevron!);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(combobox());
  });

  it('starts each open from a clean filter', () => {
    renderSelect(longList);
    openList();
    typeFilter('bin 11');
    fireEvent.keyDown(combobox(), { key: 'Tab' });
    openList();
    expect(combobox()).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(SELECT_FILTER_THRESHOLD);
  });
});

describe('Select — windowing a very long list', () => {
  const hugeList = bins(SELECT_WINDOW_THRESHOLD * 30);

  it('renders only the rows near the viewport, but reports the whole list to assistive tech', () => {
    renderSelect(hugeList);
    openList();

    const rendered = screen.getAllByRole('option');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(SELECT_WINDOW_THRESHOLD);
    expect(rendered[0]).toHaveAttribute('aria-setsize', String(hugeList.length));
    expect(rendered[0]).toHaveAttribute('aria-posinset', '1');
    // The rows below the window are absent from the DOM, not dropped from the list.
    expect(screen.queryByRole('option', { name: 'Bin 2999' })).toBeNull();
  });

  it('finds a row the window has not reached, by filtering rather than scrolling', () => {
    const onChange = renderSelect(hugeList);
    openList();
    typeFilter('bin 2999');
    fireEvent.click(screen.getByRole('option', { name: 'Bin 2999' }));
    expect(onChange).toHaveBeenCalledWith('bin-2999');
  });
});
