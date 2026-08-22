import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumberInput, type NumberInputProps } from './number-input';

/** A minimal controlled host, standing in for a React Hook Form field. */
function Controlled({
  onChange,
  ...bounds
}: { onChange?: (v: string) => void } & Pick<NumberInputProps, 'min' | 'max' | 'step'>) {
  const [value, setValue] = useState('');
  return (
    <NumberInput
      aria-label="Weight"
      value={value}
      {...bounds}
      onChange={(e) => {
        setValue(e.target.value);
        onChange?.(e.target.value);
      }}
    />
  );
}

describe('NumberInput', () => {
  it('renders a text box (not a native number spinbutton), so it can hold operators', () => {
    render(<NumberInput aria-label="Quantity" />);
    const input = screen.getByRole('textbox', { name: 'Quantity' });
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('evaluates a typed calculation on Enter and writes the result back', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '500/2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('250');
  });

  it('evaluates on blur before the field settles', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '(2+3)*4' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('20');
  });

  it('leaves a plainly-typed number untouched', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('42');
  });

  it('leaves an invalid calculation untouched (validation can then flag it)', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '500/' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('500/');
  });

  it('routes the computed value through onChange so a form sees it', () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '10*3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('30');
  });

  it('swallows Enter only when it actually computed a sum (so plain numbers can submit)', () => {
    const onKeyDown = vi.fn();
    render(<NumberInput aria-label="Qty" defaultValue="" onKeyDown={onKeyDown} />);
    const input = screen.getByRole('textbox', { name: 'Qty' });

    fireEvent.change(input, { target: { value: '6*7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown.mock.calls.at(-1)![0].defaultPrevented).toBe(true);

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown.mock.calls.at(-1)![0].defaultPrevented).toBe(false);
  });

  it('shows a live result preview while a calculation is being typed', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '500/2' } });
    expect(screen.getByText('= 250')).toBeInTheDocument();
  });

  it('exposes the calculator hint to assistive tech via aria-describedby, merging any existing ids', () => {
    render(<NumberInput aria-label="Cost" aria-describedby="external-help" />);
    const input = screen.getByRole('textbox', { name: 'Cost' });
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('external-help');
    const ids = describedBy.split(' ');
    const hintId = ids.find((id) => id !== 'external-help')!;
    expect(document.getElementById(hintId)?.textContent).toMatch(/calculation/i);
  });

  it('announces the computed result in a live region', () => {
    render(<Controlled />);
    const input = screen.getByRole('textbox', { name: 'Weight' });
    fireEvent.change(input, { target: { value: '9*9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Calculated 81')).toBeInTheDocument();
  });

  it('forwards its ref to the underlying input', () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<NumberInput aria-label="Qty" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  describe('declared bounds (issue #676)', () => {
    it('drops characters a number field cannot mean, as they are typed', () => {
      const onChange = vi.fn();
      render(<Controlled onChange={onChange} />);
      const input = screen.getByRole('textbox', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '12kg' } });
      expect(input).toHaveValue('12');
      expect(onChange).toHaveBeenLastCalledWith('12');
    });

    it("round-trips the calculator's own exponential result instead of mangling it", () => {
      // `1/10000000` settles to `1e-7`. Stripping the `e` would leave `1-7`, which the next blur
      // reads as a subtraction and settles again to `-6`.
      render(<Controlled min={0} step="any" />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '1/10000000' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input).toHaveValue('1e-7');
      fireEvent.blur(input);
      expect(input).toHaveValue('1e-7');
    });

    it('leaves a pasted comma in place rather than guessing which separator it is', () => {
      // Dropping it would read `250,00` as `25000` for the German catalogue's users. Kept, the
      // entry parses as nothing and the call site reports it (issue #675's contract).
      render(<Controlled />);
      const input = screen.getByRole('textbox', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '250,00' } });
      expect(input).toHaveValue('250,00');
      fireEvent.blur(input);
      expect(input).toHaveValue('250,00');
    });

    it('leaves a value below the declared minimum exactly as typed, and marks it invalid', () => {
      const onChange = vi.fn();
      render(<Controlled min={1} onChange={onChange} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '0' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('0');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(onChange).toHaveBeenLastCalledWith('0');
    });

    it('leaves a value above the declared maximum alone rather than clamping it', () => {
      render(<Controlled max={100} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '250' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('250');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('reports an off-step entry without rounding the figure the user typed', () => {
      // Rounding `2.5` to `3` here would quantise a three-decimal currency to two, and settle a
      // mistyped price to something saveable. The range says what is wrong; it does not guess.
      render(<Controlled min={0} step={1} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '2.5' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('2.5');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('drops the invalid mark once the value comes back into range', () => {
      render(<Controlled min={1} max={9} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '99' } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      fireEvent.change(input, { target: { value: '5' } });
      expect(input).not.toHaveAttribute('aria-invalid');
    });

    it('never downgrades an invalidity the surrounding form field injected', () => {
      render(<NumberInput aria-label="Weight" min={0} aria-invalid defaultValue="5" />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('still works out a calculation, which is a rewrite the user asked for', () => {
      render(<Controlled min={0} max={10} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '5*4' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input).toHaveValue('20');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('leaves an in-range decimal exactly as typed, so a money field can pad its own', () => {
      render(<Controlled min={0} step="any" />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '8.00' } });
      fireEvent.blur(input);
      expect(input).toHaveValue('8.00');
    });

    it('exposes the range to assistive tech as a spinbutton', () => {
      render(<Controlled min={1} max={9} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      expect(input).toHaveAttribute('aria-valuemin', '1');
      expect(input).toHaveAttribute('aria-valuemax', '9');
      expect(input).not.toHaveAttribute('aria-valuenow');
      fireEvent.change(input, { target: { value: '4' } });
      expect(input).toHaveAttribute('aria-valuenow', '4');
    });

    it('steps the value with the arrow keys, staying inside the range', () => {
      render(<Controlled min={1} max={3} step={1} />);
      const input = screen.getByRole('spinbutton', { name: 'Weight' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('1');
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('2');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input).toHaveValue('1');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input).toHaveValue('1');
    });

    it('leaves an unbounded field a plain text box that the arrow keys do not touch', () => {
      render(<Controlled />);
      const input = screen.getByRole('textbox', { name: 'Weight' });
      fireEvent.change(input, { target: { value: '7' } });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input).toHaveValue('7');
    });
  });
});
