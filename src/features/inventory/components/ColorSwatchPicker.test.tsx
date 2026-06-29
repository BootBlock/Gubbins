import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import type { LocationColor } from '../location-color';

afterEach(cleanup);

function renderPicker(value: LocationColor | null = null, onChange = vi.fn()) {
  render(
    <>
      <span id="color-label">Colour</span>
      <ColorSwatchPicker labelledBy="color-label" value={value} onChange={onChange} />
    </>,
  );
  return onChange;
}

describe('ColorSwatchPicker — accessible radiogroup', () => {
  it('renders a "No colour" radio plus all 12 swatches', () => {
    renderPicker();
    expect(screen.getByRole('radiogroup', { name: 'Colour' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(13);
    expect(screen.getByRole('radio', { name: 'No colour' }).getAttribute('aria-checked')).toBe('true');
  });

  it('marks the stored colour as checked and the single tab stop', () => {
    renderPicker('teal');
    const teal = screen.getByRole('radio', { name: 'Teal' });
    expect(teal.getAttribute('aria-checked')).toBe('true');
    expect(teal.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'No colour' }).getAttribute('tabindex')).toBe('-1');
  });

  it('selects a swatch on click', () => {
    const onChange = renderPicker();
    fireEvent.click(screen.getByRole('radio', { name: 'Rose' }));
    expect(onChange).toHaveBeenCalledWith('rose');
  });

  it('arrow keys move and select (wrapping past the ends)', () => {
    const onChange = renderPicker(null);
    const none = screen.getByRole('radio', { name: 'No colour' });
    none.focus();
    fireEvent.keyDown(none, { key: 'ArrowRight' }); // → first colour
    expect(onChange).toHaveBeenLastCalledWith('rose');
    fireEvent.keyDown(none, { key: 'ArrowLeft' }); // wrap back to last swatch
    expect(onChange).toHaveBeenLastCalledWith('slate');
  });

  it('clears back to no colour', () => {
    const onChange = renderPicker('teal');
    fireEvent.click(screen.getByRole('radio', { name: 'No colour' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
