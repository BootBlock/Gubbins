import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Modal } from './modal';
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

  it('keeps the active option on a real row when the list shrinks underneath it', () => {
    // A refetch can replace the options while the list is open, stranding the active index past
    // the end of the new list — where the highlight, `aria-activedescendant` and Enter would all
    // point at a row that no longer exists.
    const onChange = vi.fn();
    const label = <span id="loc-label">Location</span>;
    const view = render(
      <>
        {label}
        <Select aria-labelledby="loc-label" value="" onChange={onChange} options={bins(20)} />
      </>,
    );
    openList();
    for (let i = 0; i < 15; i += 1) fireEvent.keyDown(combobox(), { key: 'ArrowDown' });

    view.rerender(
      <>
        {label}
        <Select aria-labelledby="loc-label" value="" onChange={onChange} options={bins(3)} />
      </>,
    );

    expect(combobox().getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Bin 2' }).id,
    );
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('bin-2');
  });

  it('keeps the focus when a shrinking list takes the filter field away underneath it', () => {
    // Crossing back under the threshold unmounts the field rather than blurring it, so nothing
    // hands the focus on. An open list whose focus has fallen to the body answers no key at all
    // — and its Escape reaches the enclosing dialog and closes that instead.
    const onChange = vi.fn();
    const label = <span id="loc-label">Location</span>;
    const view = render(
      <>
        {label}
        <Select aria-labelledby="loc-label" value="" onChange={onChange} options={bins(20)} />
      </>,
    );
    openList();
    expect(combobox().tagName).toBe('INPUT');

    view.rerender(
      <>
        {label}
        <Select aria-labelledby="loc-label" value="" onChange={onChange} options={bins(3)} />
      </>,
    );

    expect(combobox().tagName).toBe('DIV');
    expect(document.activeElement).toBe(combobox());
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('dismisses from the chrome around the filter field without losing focus or reopening', () => {
    renderSelect(longList);
    openList();
    const chrome = combobox().parentElement!;

    // The press only holds the focus in place. Closing on it instead would re-arm this same box's
    // open-toggle in time for the press's own click to reopen the list and discard the query.
    expect(fireEvent.mouseDown(chrome)).toBe(false);
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.click(chrome);
    expect(screen.queryByRole('listbox')).toBeNull();
    // Focus stays on the control. Letting it fall to the dialog behind would strand the enclosing
    // focus trap, which resolves Tab by finding the focused element among its own descendants.
    expect(document.activeElement).toBe(combobox());
  });

  it('swallows the focus change on a press inside the list, so a touch tap still chooses', () => {
    const onChange = renderSelect(longList);
    openList();
    const option = screen.getByRole('option', { name: 'Bin 2' });

    // `false` means the default action — moving focus off the filter field — was prevented.
    // Without that, a tap blurs the field via the compatibility mouse events that arrive *after*
    // the pointer sequence ends, closing the list before its click lands: nothing gets chosen.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('bin-2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says nothing about matches when there is no filter to have matched', () => {
    // A picker with nothing but its "＋ New…" row (a fresh install has no locations yet) has not
    // searched for anything, so reporting no matches would be a lie about a search never run.
    renderSelect([{ value: '__create__', label: '＋ New location…', kind: 'action' }]);
    openList();
    expect(screen.queryByText('No matching options')).toBeNull();
    expect(screen.getByRole('option', { name: '＋ New location…' })).toBeTruthy();
  });

  it('closes from the pointer via the chevron, without disturbing the filter field first', () => {
    renderSelect(longList);
    openList();
    const chevron = combobox().parentElement?.querySelector('button');
    expect(chevron).toBeTruthy();

    // The press itself only holds the focus in place — closing here would re-arm the trigger's
    // own toggle in time for this same press's click to reopen the list.
    expect(fireEvent.mouseDown(chevron!)).toBe(false);
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.click(chevron!);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(combobox());
  });

  it('closes when the field loses focus, and starts the next open from a clean filter', () => {
    renderSelect(longList);
    openList();
    typeFilter('bin 11');

    fireEvent.blur(combobox()); // focus has gone elsewhere — Tab, or a click past the control
    expect(screen.queryByRole('listbox')).toBeNull();

    openList();
    expect(combobox()).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(SELECT_FILTER_THRESHOLD);
  });
});

describe('Select — inside a Modal, where focus is trapped', () => {
  const longList = bins(SELECT_FILTER_THRESHOLD);

  function renderInModal(onClose = vi.fn()) {
    render(
      <Modal open onClose={onClose} title="Add item">
        <button>Before</button>
        <span id="loc-label">Location</span>
        <Select aria-labelledby="loc-label" value="" onChange={vi.fn()} options={longList} />
        <button>After</button>
      </Modal>,
    );
    return onClose;
  }

  it('Tab closes the list and hands the trap the focused field, not the inert trigger', () => {
    renderInModal();
    openList();
    fireEvent.keyDown(combobox(), { key: 'Tab' });

    expect(screen.queryByRole('listbox')).toBeNull();
    // The trap resolves Tab from whatever holds focus. Yanking focus back to the trigger — which
    // is `tabIndex={-1}` while filtering, so not in the trap's tab order — would make it fall
    // back to the *first* control in the dialog instead of the next one.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
  });

  it('Escape closes only the list, never the dialog behind it', () => {
    const onClose = renderInModal();
    openList();
    typeFilter('bin 1');

    fireEvent.keyDown(combobox(), { key: 'Escape' }); // clears the filter
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(combobox(), { key: 'Escape' }); // closes the list
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // …and only once the list is gone does Escape belong to the dialog again.
    fireEvent.keyDown(combobox(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
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
