import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FormField } from './field';
import { Input } from './input';

afterEach(cleanup);

describe('FormField — accessible labelled control (spec §3 / WCAG 3.3.1, 1.3.1, 4.1.3)', () => {
  it('renders the label associated with the control', () => {
    render(
      <FormField label="Name">
        <Input defaultValue="hi" />
      </FormField>,
    );
    // Implicit label association (wrapping <label>): the control is found by label text.
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('marks a valid field with no aria-invalid and renders no error', () => {
    render(
      <FormField label="Name">
        <Input />
      </FormField>,
    );
    const control = screen.getByLabelText('Name');
    expect(control.getAttribute('aria-invalid')).toBeNull();
    expect(control.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wires aria-invalid + aria-describedby to an announced error when invalid', () => {
    render(
      <FormField label="Quantity" error="Must be positive">
        <Input />
      </FormField>,
    );
    const control = screen.getByLabelText('Quantity');
    const alert = screen.getByRole('alert');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(alert.textContent).toBe('Must be positive');
    // The control's aria-describedby points at the alert element's id.
    expect(control.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('never clobbers an explicit aria prop set at the call site', () => {
    render(
      <FormField label="Custom" error="bad">
        <Input aria-describedby="external-hint" />
      </FormField>,
    );
    const control = screen.getByLabelText('Custom');
    // The child's own aria-describedby wins (defence against accidental override).
    expect(control.getAttribute('aria-describedby')).toBe('external-hint');
  });
});
