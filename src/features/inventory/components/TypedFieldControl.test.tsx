import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TypedFieldControl } from './TypedFieldControl';

/**
 * Behaviour tests for {@link TypedFieldControl} — the shared per-`FieldType` value
 * control used by both the category schema's Default-value editor and the per-item
 * Custom Fields editor (Edit item dialog), so a defect here would silently break
 * setting a field's value in *both* places at once.
 */
afterEach(cleanup);

describe('TypedFieldControl — text-like types', () => {
  it('renders a plain text input for TEXT (and the default/unlisted case)', () => {
    const onChange = vi.fn();
    render(<TypedFieldControl fieldType="TEXT" value="hello" onChange={onChange} ariaLabel="Voltage" />);
    const input = screen.getByLabelText('Voltage');
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.change(input, { target: { value: 'world' } });
    expect(onChange).toHaveBeenCalledWith('world');
  });

  it('renders a textarea for LONG_TEXT', () => {
    const onChange = vi.fn();
    render(<TypedFieldControl fieldType="LONG_TEXT" value="notes" onChange={onChange} ariaLabel="Notes" />);
    const textarea = screen.getByLabelText('Notes');
    expect(textarea.tagName).toBe('TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'more notes' } });
    expect(onChange).toHaveBeenCalledWith('more notes');
  });

  it('renders a url input for URL', () => {
    render(<TypedFieldControl fieldType="URL" value="" onChange={vi.fn()} ariaLabel="Datasheet" />);
    expect(screen.getByLabelText('Datasheet')).toHaveAttribute('type', 'url');
  });

  it('renders a number input for NUMBER', () => {
    render(<TypedFieldControl fieldType="NUMBER" value="" onChange={vi.fn()} ariaLabel="Resistance" />);
    const input = screen.getByLabelText('Resistance');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).not.toHaveAttribute('min');
  });

  it('renders a 1-5-constrained number input for RATING', () => {
    render(<TypedFieldControl fieldType="RATING" value="" onChange={vi.fn()} ariaLabel="Condition" />);
    const input = screen.getByLabelText('Condition');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '5');
  });

  it('renders a date input for DATE', () => {
    render(<TypedFieldControl fieldType="DATE" value="" onChange={vi.fn()} ariaLabel="Calibrated" />);
    expect(screen.getByLabelText('Calibrated')).toHaveAttribute('type', 'date');
  });
});

describe('TypedFieldControl — BOOLEAN (Yes/No toggle)', () => {
  it('renders a two-button radiogroup and reflects the current value', () => {
    render(<TypedFieldControl fieldType="BOOLEAN" value="true" onChange={vi.fn()} ariaLabel="In stock" />);
    const group = screen.getByRole('radiogroup', { name: 'In stock' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'false');
  });

  it('falls back to showing No selected (without committing it) when the value is blank', () => {
    render(<TypedFieldControl fieldType="BOOLEAN" value="" onChange={vi.fn()} ariaLabel="In stock" />);
    expect(screen.getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onChange with true/false on click', () => {
    const onChange = vi.fn();
    render(<TypedFieldControl fieldType="BOOLEAN" value="false" onChange={onChange} ariaLabel="In stock" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(onChange).toHaveBeenCalledWith('true');
  });
});

describe('TypedFieldControl — ON_OFF (checkbox)', () => {
  it('renders a checkbox showing On/Off text and toggles it', () => {
    const onChange = vi.fn();
    render(<TypedFieldControl fieldType="ON_OFF" value="false" onChange={onChange} ariaLabel="Powered" />);
    expect(screen.getByText('Off')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: 'Powered' });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith('true');
  });

  it('shows On text when checked', () => {
    render(<TypedFieldControl fieldType="ON_OFF" value="true" onChange={vi.fn()} ariaLabel="Powered" />);
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Powered' })).toBeChecked();
  });
});

describe('TypedFieldControl — SELECT', () => {
  it('lists a blank placeholder plus the given options, and calls onChange on pick', () => {
    const onChange = vi.fn();
    render(
      <TypedFieldControl
        fieldType="SELECT"
        value=""
        onChange={onChange}
        options={['Red', 'Green', 'Blue']}
        ariaLabel="Colour"
      />,
    );
    const combobox = screen.getByRole('combobox', { name: 'Colour' });
    fireEvent.click(combobox);
    expect(screen.getByRole('option', { name: '—' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Green' }));
    expect(onChange).toHaveBeenCalledWith('Green');
  });

  it('renders just the blank placeholder when no options are defined', () => {
    render(
      <TypedFieldControl fieldType="SELECT" value="" onChange={vi.fn()} options={null} ariaLabel="Colour" />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Colour' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});

describe('TypedFieldControl — naming via labelId', () => {
  it('names the control via aria-labelledby when labelId is given instead of ariaLabel', () => {
    render(
      <>
        <span id="voltage-label">Voltage</span>
        <TypedFieldControl fieldType="TEXT" value="" onChange={vi.fn()} labelId="voltage-label" />
      </>,
    );
    expect(screen.getByLabelText('Voltage')).toBeInTheDocument();
  });
});
