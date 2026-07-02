import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LocationSelect, type LocationOption } from './LocationSelect';

afterEach(cleanup);

const options: LocationOption[] = [
  { value: '', label: '— Top level —' },
  { value: 'workshop', label: 'Workshop', meta: '5 items' },
  { value: 'cabinet', label: 'Cabinet', meta: '1 item' },
];

function renderSelect(value = '', onChange = vi.fn()) {
  render(
    <>
      <span id="parent-label">Parent (optional)</span>
      <LocationSelect labelledBy="parent-label" value={value} onChange={onChange} options={options} />
    </>,
  );
  return onChange;
}

describe('LocationSelect — accessible parent picker', () => {
  it('names the combobox from its label and shows the selected option', () => {
    renderSelect('workshop');
    const combo = screen.getByRole('combobox', { name: 'Parent (optional)' });
    expect(combo.getAttribute('aria-expanded')).toBe('false');
    expect(combo.textContent).toContain('Workshop');
  });

  it('opens on click and renders each option with its right-aligned item count', () => {
    renderSelect();
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent (optional)' }));
    expect(screen.getByRole('listbox', { name: 'Parent (optional)' })).toBeTruthy();
    // The count hint rides along in the option and carries the dimmed token class.
    const count = screen.getByText('5 items');
    expect(count.className).toContain('text-item-count');
    // Singular vs plural is honoured.
    expect(screen.getByText('1 item')).toBeTruthy();
    // The synthetic "top level" row has no count hint.
    const topLevel = screen.getByRole('option', { name: '— Top level —' });
    expect(topLevel.textContent).toBe('— Top level —');
  });

  it('reports the chosen value and closes when an option is clicked', () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByRole('combobox', { name: 'Parent (optional)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Workshop 5 items' }));
    expect(onChange).toHaveBeenCalledWith('workshop');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is keyboard-driven: ArrowDown then Enter selects via aria-activedescendant', () => {
    const onChange = renderSelect();
    const combo = screen.getByRole('combobox', { name: 'Parent (optional)' });
    combo.focus();
    fireEvent.keyDown(combo, { key: 'ArrowDown' }); // open, active = selected (top level, index 0)
    fireEvent.keyDown(combo, { key: 'ArrowDown' }); // active = Workshop (index 1)
    expect(combo.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Workshop 5 items' }).id,
    );
    fireEvent.keyDown(combo, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('workshop');
  });

  it('closes on Escape without selecting', () => {
    const onChange = renderSelect();
    const combo = screen.getByRole('combobox', { name: 'Parent (optional)' });
    combo.focus();
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets an action row apart with a divider and accent tint (not a location swatch)', () => {
    render(
      <>
        <span id="loc-label">Location</span>
        <LocationSelect
          labelledBy="loc-label"
          value="workshop"
          onChange={vi.fn()}
          options={[
            { value: 'workshop', label: 'Workshop', colorClass: 'text-loc-teal' },
            { value: '__create__', label: '＋ New location…', kind: 'action' },
          ]}
        />
      </>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Location' }));
    const action = screen.getByRole('option', { name: '＋ New location…' });
    // Fenced off with a top divider and tinted with the action accent — never a swatch.
    expect(action.className).toContain('border-t');
    expect(action.querySelector('span')?.className).toContain('text-accent');
  });
});
