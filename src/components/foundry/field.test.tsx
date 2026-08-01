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

  it('renders a hint info-badge without polluting the control’s accessible name', () => {
    render(
      <FormField label="Name" hint="Some **help** text.">
        <Input />
      </FormField>,
    );
    // The badge is present (its own generic accessible name)…
    expect(screen.getByRole('img', { name: 'More information' })).toBeTruthy();
    // …and the control is still found by its bare label — the hint lives outside the
    // <label>, so it never folds into the control's accessible name.
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('renders no hint badge when none is given', () => {
    render(
      <FormField label="Name">
        <Input />
      </FormField>,
    );
    expect(screen.queryByRole('img', { name: 'More information' })).toBeNull();
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

describe('FormField — compact density for nested editors', () => {
  it('keeps the full label/error wiring while rendering the denser caption', () => {
    render(
      <FormField compact label="Purchase price" error="This can’t be a negative number.">
        <Input />
      </FormField>,
    );
    const control = screen.getByLabelText('Purchase price');
    const alert = screen.getByRole('alert');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('drops the label to the compact type scale and gap', () => {
    const { container } = render(
      <FormField compact label="Purchase price">
        <Input />
      </FormField>,
    );
    const caption = container.querySelector('label > span');
    expect(caption?.className).toContain('text-xs');
    expect(caption?.className).toContain('mb-field-gap-compact');
    expect(caption?.className).not.toContain('text-sm');
  });
});

describe('FormField — advisory warning tier (issue #344)', () => {
  it('shows the warning and describes it to the control, but never marks it invalid', () => {
    render(
      <FormField label="Barcode" warning="Its check digit doesn’t match.">
        <Input />
      </FormField>,
    );
    const control = screen.getByLabelText('Barcode');
    const warning = screen.getByText('Its check digit doesn’t match.');
    expect(control.getAttribute('aria-invalid')).toBeNull();
    expect(control.getAttribute('aria-describedby')).toBe(warning.id);
  });

  it('keeps the live region mounted while quiet, so a later warning is announced', () => {
    // A role="status" inserted at warn time is frequently not announced (see LiveRegion),
    // so an opted-in field pre-mounts an empty region rather than creating one on demand.
    const { container } = render(
      <FormField label="Barcode" warning="">
        <Input />
      </FormField>,
    );
    const region = container.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe('');
  });

  it('mounts no live region at all for a field that never warns', () => {
    const { container } = render(
      <FormField label="Name">
        <Input />
      </FormField>,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows only the error when a field has both', () => {
    render(
      <FormField label="Barcode" error="Required" warning="Its check digit doesn’t match.">
        <Input />
      </FormField>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Required');
    expect(screen.queryByText('Its check digit doesn’t match.')).toBeNull();
    expect(screen.getByLabelText('Barcode').getAttribute('aria-invalid')).toBe('true');
  });
});
