import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { AutocompleteField } from './autocomplete';
import { FormField } from './field';
import { Input } from './input';
import { Textarea } from './textarea';
import { defaultTextLimit } from './text-limit';

afterEach(cleanup);

/** A spanner, U+1F527 — one character, two UTF-16 code units. */
const SPANNER = '🔧';

describe('defaultTextLimit', () => {
  it('gives every typed-text input a ceiling', () => {
    for (const type of ['text', 'search', 'email', 'tel', 'password']) {
      expect(defaultTextLimit(type), type).toBe(TEXT_LIMITS.line);
    }
  });

  it('gives a web address the roomier tier', () => {
    expect(defaultTextLimit('url')).toBe(TEXT_LIMITS.url);
  });

  it('leaves a control that holds no typed text alone', () => {
    for (const type of ['checkbox', 'radio', 'date', 'color', 'file', 'number', 'range']) {
      expect(defaultTextLimit(type), type).toBeUndefined();
    }
  });
});

describe('Input — length limit (issue #346)', () => {
  it('does not put maxLength on the element, so a paste is never silently truncated', () => {
    render(<Input aria-label="Name" maxLength={5} />);
    const control = screen.getByLabelText('Name') as HTMLInputElement;
    expect(control.getAttribute('maxlength')).toBeNull();

    fireEvent.change(control, { target: { value: 'far too long to fit' } });
    // Every character the user handed the field is still in it.
    expect(control.value).toBe('far too long to fit');
  });

  it('marks itself invalid past the limit, and valid again once it fits', () => {
    render(<Input aria-label="Name" maxLength={5} />);
    const control = screen.getByLabelText('Name');

    fireEvent.change(control, { target: { value: 'abcde' } });
    expect(control.getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(control, { target: { value: 'abcdef' } });
    expect(control.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(control, { target: { value: 'abc' } });
    expect(control.getAttribute('aria-invalid')).toBeNull();
  });

  it('counts an emoji once, so a name of five spanners fits a five-character field', () => {
    render(<Input aria-label="Name" maxLength={5} />);
    const control = screen.getByLabelText('Name');
    fireEvent.change(control, { target: { value: SPANNER.repeat(5) } });
    expect(control.getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(control, { target: { value: SPANNER.repeat(6) } });
    expect(control.getAttribute('aria-invalid')).toBe('true');
  });

  it('applies a default limit to a field that declares none', () => {
    render(<Input aria-label="Name" />);
    const control = screen.getByLabelText('Name');
    fireEvent.change(control, { target: { value: 'a'.repeat(TEXT_LIMITS.line + 1) } });
    expect(control.getAttribute('aria-invalid')).toBe('true');
  });

  it('reports a stored over-long value at mount, without waiting for a keystroke', () => {
    render(<Input aria-label="Name" defaultValue={'a'.repeat(TEXT_LIMITS.line + 1)} />);
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps an invalidity the call site injected, rather than replacing it', () => {
    render(<Input aria-label="Name" aria-invalid maxLength={500} />);
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('still calls the change handler the call site passed', () => {
    const seen: string[] = [];
    render(<Input aria-label="Name" onChange={(e) => seen.push(e.currentTarget.value)} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'hi' } });
    expect(seen).toEqual(['hi']);
  });
});

describe('Textarea — length limit (issue #346)', () => {
  it('defaults to the note tier and reports an entry past it', () => {
    render(<Textarea aria-label="Notes" />);
    const control = screen.getByLabelText('Notes');
    expect(control.getAttribute('maxlength')).toBeNull();

    fireEvent.change(control, { target: { value: 'a'.repeat(TEXT_LIMITS.note) } });
    expect(control.getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(control, { target: { value: 'a'.repeat(TEXT_LIMITS.note + 1) } });
    expect(control.getAttribute('aria-invalid')).toBe('true');
  });

  it('takes a wider limit for a box that holds a payload rather than prose', () => {
    render(<Textarea aria-label="Paste" maxLength={TEXT_LIMITS.payload} />);
    const control = screen.getByLabelText('Paste');
    fireEvent.change(control, { target: { value: 'a'.repeat(TEXT_LIMITS.note + 1) } });
    expect(control.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('FormField — reporting a control that is too long', () => {
  it('announces the overflow and marks the control invalid', () => {
    render(
      <FormField label="Name">
        <Input maxLength={5} />
      </FormField>,
    );
    const control = screen.getByLabelText('Name');
    fireEvent.change(control, { target: { value: 'abcdefgh' } });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('3 characters too many. The limit is 5.');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('lets a message the call site wrote outrank the length one', () => {
    render(
      <FormField label="Name" error="Please choose a different name.">
        <Input maxLength={5} />
      </FormField>,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'abcdefgh' } });
    expect(screen.getByRole('alert').textContent).toBe('Please choose a different name.');
  });

  it('counts down as the field fills, and stops once it overflows', () => {
    render(
      <FormField label="Name">
        <Input maxLength={10} />
      </FormField>,
    );
    const control = screen.getByLabelText('Name');

    // Well short of the limit: nothing to say.
    fireEvent.change(control, { target: { value: 'ab' } });
    expect(screen.queryByText(/characters? left/)).toBeNull();

    fireEvent.change(control, { target: { value: 'abcdefghi' } });
    expect(screen.getByText('1 character left')).toBeTruthy();

    fireEvent.change(control, { target: { value: 'abcdefghij' } });
    expect(screen.getByText('0 characters left')).toBeTruthy();

    // Past the limit the alert says it better, so the countdown gives way.
    fireEvent.change(control, { target: { value: 'abcdefghijk' } });
    expect(screen.queryByText(/characters? left/)).toBeNull();
  });

  it('reports a type-ahead field the same way as a plain one', () => {
    function Harness() {
      const [value, setValue] = useState('');
      return <AutocompleteField label="Manufacturer" value={value} onChange={setValue} suggestions={[]} />;
    }
    render(<Harness />);
    const control = screen.getByLabelText('Manufacturer');

    fireEvent.change(control, { target: { value: 'a'.repeat(TEXT_LIMITS.line + 2) } });
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('2 characters too many. The limit is 500.');
  });

  it('leaves a fixed-format code field truncating natively, as it always did', () => {
    // The three-letter currency box is the one place a hard cap is right: a fourth letter would
    // be stored as a currency nobody can price in.
    render(
      <AutocompleteField label="Currency" value="" onChange={() => {}} suggestions={[]} maxLength={3} />,
    );
    expect(screen.getByLabelText('Currency').getAttribute('maxlength')).toBe('3');
  });

  it('says nothing about length for a control that measures none', () => {
    render(
      <FormField label="Quantity">
        <Input type="number" />
      </FormField>,
    );
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '12' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/characters? left/)).toBeNull();
  });
});
