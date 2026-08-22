import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
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
  it('keeps every character a user types past the limit, rather than refusing the keystroke', async () => {
    render(<Input aria-label="Name" maxLength={5} />);
    const control = screen.getByLabelText('Name') as HTMLInputElement;
    // Typed through user-event, not `fireEvent.change`: a programmatic value assignment ignores
    // `maxLength` whatever the element carries, so it would pass against a natively-capped field
    // too and prove nothing. Typing is what a native cap actually refuses.
    await userEvent.type(control, 'far too long to fit');
    expect(control.value).toBe('far too long to fit');
    expect(control.getAttribute('maxlength')).toBeNull();
  });

  it('keeps a pasted value whole, rather than cutting it down to the limit', async () => {
    render(<Input aria-label="Name" maxLength={5} />);
    const control = screen.getByLabelText('Name') as HTMLInputElement;
    await userEvent.click(control);
    await userEvent.paste('a whole sentence pasted in');
    expect(control.value).toBe('a whole sentence pasted in');
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

  it('reports a value React Hook Form writes in after mount, with no keystroke or focus', async () => {
    // `reset()` writes straight into the node through the registered ref. There is no change
    // event and no focus, so a control that only read itself at mount and on focus would sit
    // there showing an over-long stored value as valid.
    function Harness() {
      const { register, reset } = useForm<{ name: string }>({ defaultValues: { name: '' } });
      return (
        <>
          <FormField label="Name">
            <Input maxLength={5} {...register('name')} />
          </FormField>
          <button type="button" onClick={() => reset({ name: 'far too long' })}>
            Load
          </button>
        </>
      );
    }
    render(<Harness />);
    const control = screen.getByLabelText('Name');
    expect(control.getAttribute('aria-invalid')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect((control as HTMLInputElement).value).toBe('far too long');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('7 characters too many. The limit is 5.');
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
        <Input maxLength={100} />
      </FormField>,
    );
    const control = screen.getByLabelText('Name');

    // Well short of the limit: nothing to say.
    fireEvent.change(control, { target: { value: 'ab' } });
    expect(screen.queryByText(/characters? left/)).toBeNull();

    fireEvent.change(control, { target: { value: 'a'.repeat(99) } });
    expect(screen.getByText('1 character left')).toBeTruthy();

    fireEvent.change(control, { target: { value: 'a'.repeat(100) } });
    expect(screen.getByText('0 characters left')).toBeTruthy();

    // Past the limit the alert says it better, so the countdown gives way.
    fireEvent.change(control, { target: { value: 'a'.repeat(101) } });
    expect(screen.queryByText(/characters? left/)).toBeNull();
  });

  it('never counts down on a field no bigger than a short code', () => {
    // A tenth of three characters is a third of one, so an unguarded window would leave a
    // three-letter currency box permanently reading "0 characters left".
    render(
      <FormField label="Currency">
        <Input maxLength={3} />
      </FormField>,
    );
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'EUR' } });
    expect(screen.queryByText(/characters? left/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still reports a short-code field that overflows', () => {
    render(
      <FormField label="Currency">
        <Input maxLength={3} />
      </FormField>,
    );
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'EURO' } });
    expect(screen.getByRole('alert').textContent).toBe('One character too many. The limit is 3.');
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
