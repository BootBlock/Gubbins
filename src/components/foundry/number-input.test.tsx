import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumberInput } from './number-input';

/** A minimal controlled host, standing in for a React Hook Form field. */
function Controlled({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <NumberInput
      aria-label="Weight"
      value={value}
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
});
