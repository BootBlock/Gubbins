import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColourInput, ColourSwatch } from './colour-input';

afterEach(cleanup);

/** A controlled harness, so the box reflects whatever ColourInput reports back. */
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
  it('reports the text as typed, then the canonical colour once the edit settles', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (const [typed, canonical] of [
      ['#F00', '#ff0000'],
      ['rgb(0, 255, 0)', '#00ff00'],
      ['hsl(240, 100%, 50%)', '#0000ff'],
      ['chocolate', '#d2691e'],
    ] as const) {
      fireEvent.change(box(), { target: { value: typed } });
      expect(onChange, typed).toHaveBeenLastCalledWith(typed);
      fireEvent.blur(box());
      expect(onChange, typed).toHaveBeenLastCalledWith(canonical);
    }
  });

  it('never reports a colour the user was only typing through', () => {
    // `#ff0` is yellow and `#ff00` is transparent yellow, so a control that reported only
    // *parsed* colours would store both on the way to `#ff0000` — and leave whichever one the
    // user happened to stop at. Every report must be the text that was actually in the box.
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const typed = ['#', '#f', '#ff', '#ff0', '#ff00', '#ff000', '#ff0000'];
    for (const step of typed) fireEvent.change(box(), { target: { value: step } });
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(typed);
  });

  it('reports text that is not a colour, so the field can say so', () => {
    // Swallowing it would leave the box marked invalid with no message anywhere behind it —
    // the validation seam only ever sees values that were reported.
    const onChange = vi.fn();
    render(<Harness initial="#ff0000" onChange={onChange} />);
    fireEvent.change(box(), { target: { value: 'chocolat' } });
    expect(onChange).toHaveBeenLastCalledWith('chocolat');
    expect(box().value).toBe('chocolat');
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

  it('re-renders the value in the notation picked from the menu, without editing it', async () => {
    const onChange = vi.fn();
    render(<Harness initial="#d2691e" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /HSL/ }));
    expect(box().value).toBe('hsl(25, 75%, 47%)');
    // Reading the colour another way is not an edit to it.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not drift the colour when a rounded notation is shown and then left', async () => {
    // `hsl()` is rendered at whole degrees and percent, so it cannot name every 8-bit colour:
    // #4ab66a shows as hsl(138, 43%, 50%), which reads back as #49b66a. Settling must return
    // the colour the box was rendered *from*, or merely looking at it would change it.
    const onChange = vi.fn();
    render(<Harness initial="#4ab66a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /HSL/ }));
    fireEvent.focus(box());
    fireEvent.blur(box());
    fireEvent.focus(box());
    fireEvent.blur(box());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps any alpha when a colour is picked from the native swatch', () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff000080" onChange={onChange} />);
    fireEvent.change(swatch(), { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenLastCalledWith('#00ff0080');
  });

  it('stores exactly the picked colour, whatever notation the box is showing', async () => {
    // The pick must not be laundered through the displayed spelling: rendering #4ab66a as HSL
    // and reading it back gives #49b66a, so a colour picked while showing HSL would be stored
    // as a neighbouring one.
    const onChange = vi.fn();
    render(<Harness initial="#000000" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /HSL/ }));
    fireEvent.change(swatch(), { target: { value: '#4ab66a' } });
    fireEvent.blur(swatch());
    expect(onChange).toHaveBeenLastCalledWith('#4ab66a');
  });

  it('settles a swatch pick on its own blur, so a blur-committing caller hears about it', () => {
    const onBlur = vi.fn();
    render(<ColourInput value="" onChange={vi.fn()} onBlur={onBlur} aria-label="Filament colour" />);
    fireEvent.blur(swatch());
    expect(onBlur).toHaveBeenCalled();
  });

  it('previews a translucent value on the swatch at full strength, which cannot show alpha', () => {
    render(<Harness initial="#ff000080" />);
    expect(swatch().value).toBe('#ff0000');
  });

  it('shows a stored value that is not a colour exactly as stored', () => {
    // Reachable when a field is retyped from TEXT, or from an import — the old text stays.
    render(<Harness initial="office" />);
    expect(box().value).toBe('office');
    expect(swatch().value).toBe('#000000');
  });

  it('offers no notation previews for a value that is not a colour', async () => {
    render(<Harness initial="office" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    await screen.findByRole('menu');
    // Absent entirely, rather than previews of some substituted colour the user never entered.
    expect(screen.queryAllByTestId('colour-preview')).toHaveLength(0);
  });

  it('previews every notation for a colour that reads', async () => {
    render(<Harness initial="#ff0000" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as' }));
    await screen.findByRole('menu');
    expect(screen.getAllByTestId('colour-preview').map((el) => el.textContent)).toEqual([
      '#FF0000',
      'rgb(255, 0, 0)',
      'hsl(0, 100%, 50%)',
      'hsb(0, 100%, 100%)',
      'red',
    ]);
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
