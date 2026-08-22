import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColourInput, ColourSwatch } from './colour-input';

afterEach(cleanup);

/** A controlled harness, so the box reflects the canonical value ColourInput reports back. */
function Harness({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ColourInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      aria-label="Filament colour"
    />
  );
}

const box = () => screen.getByLabelText('Filament colour') as HTMLInputElement;
const swatch = () => screen.getByLabelText('Pick a colour') as HTMLInputElement;

describe('ColourInput', () => {
  it('reports the canonical hex for whatever notation is typed', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (const [typed, canonical] of [
      ['#F00', '#ff0000'],
      ['rgb(0, 255, 0)', '#00ff00'],
      ['hsl(240, 100%, 50%)', '#0000ff'],
      ['chocolate', '#d2691e'],
    ] as const) {
      fireEvent.change(box(), { target: { value: typed } });
      expect(onChange, typed).toHaveBeenLastCalledWith(canonical);
    }
  });

  it('leaves a half-typed value alone instead of clearing what is stored', () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff0000" onChange={onChange} />);
    fireEvent.change(box(), { target: { value: 'choc' } });
    expect(box().value).toBe('choc');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the stored value when the box is emptied', () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff0000" onChange={onChange} />);
    fireEvent.change(box(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('tidies a parsed value into the shown notation on blur', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'red' } });
    fireEvent.blur(box());
    expect(box().value).toBe('#FF0000');
  });

  it('leaves an unreadable value in the box, marked invalid, for its message to name', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'burnt sienna-ish' } });
    fireEvent.blur(box());
    expect(box().value).toBe('burnt sienna-ish');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
  });

  it('re-renders the value in the notation picked from the menu', async () => {
    render(<Harness initial="#d2691e" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /HSL/ }));
    expect(box().value).toBe('hsl(25, 75%, 47%)');
  });

  it('keeps any alpha when a colour is picked from the native swatch', () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff000080" onChange={onChange} />);
    fireEvent.change(swatch(), { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenLastCalledWith('#00ff0080');
  });

  it('previews a translucent value on the swatch at full strength, which cannot show alpha', () => {
    render(<Harness initial="#ff000080" />);
    expect(swatch().value).toBe('#ff0000');
  });

  it('follows the value when it changes from outside', () => {
    const { rerender } = render(
      <ColourInput value="#ff0000" onChange={vi.fn()} aria-label="Filament colour" />,
    );
    expect(box().value).toBe('#FF0000');
    rerender(<ColourInput value="#0000ff" onChange={vi.fn()} aria-label="Filament colour" />);
    expect(box().value).toBe('#0000FF');
  });
});

describe('ColourSwatch', () => {
  it('shows the hex beside the swatch, so colour is never the only carrier', () => {
    render(<ColourSwatch value="#d2691e" />);
    expect(screen.getByText('#D2691E')).toBeInTheDocument();
  });

  it('shows an unreadable value as its own text', () => {
    render(<ColourSwatch value="teal-ish" />);
    expect(screen.getByText('teal-ish')).toBeInTheDocument();
  });
});
