import { describe, it, expect } from 'vitest';
import { fieldAria } from './field-aria';

describe('fieldAria — accessible form-field wiring (spec §3 / WCAG 3.3.1, 1.3.1, 4.1.3)', () => {
  it('derives the error element id from the field id', () => {
    expect(fieldAria('name').errorId).toBe('name-error');
    expect(fieldAria(':r3:').errorId).toBe(':r3:-error');
  });

  it('marks a valid field with no aria-invalid or aria-describedby', () => {
    const aria = fieldAria('name');
    expect(aria.hasError).toBe(false);
    expect(aria.controlProps).toEqual({});
    expect('aria-invalid' in aria.controlProps).toBe(false);
    expect('aria-describedby' in aria.controlProps).toBe(false);
  });

  it('wires aria-invalid + aria-describedby when an error is present', () => {
    const aria = fieldAria('qty', 'Must be a positive number');
    expect(aria.hasError).toBe(true);
    expect(aria.controlProps['aria-invalid']).toBe(true);
    expect(aria.controlProps['aria-describedby']).toBe('qty-error');
    expect(aria.controlProps['aria-describedby']).toBe(aria.errorId);
  });

  it('treats an empty or whitespace-only message as no error', () => {
    expect(fieldAria('name', '').hasError).toBe(false);
    expect(fieldAria('name', '   ').hasError).toBe(false);
    expect(fieldAria('name', '   ').controlProps).toEqual({});
  });

  it('always exposes a stable errorId even when valid (for a pre-mounted region)', () => {
    expect(fieldAria('loc').errorId).toBe('loc-error');
    expect(fieldAria('loc', 'bad').errorId).toBe('loc-error');
  });
});

describe('fieldAria — advisory warning tier (issue #344)', () => {
  it('derives the warning element id from the field id', () => {
    expect(fieldAria('barcode').warningId).toBe('barcode-warning');
  });

  it('describes a warning to the control without marking it invalid', () => {
    const aria = fieldAria('barcode', undefined, 'Check digit does not match');
    expect(aria.hasWarning).toBe(true);
    expect(aria.hasError).toBe(false);
    expect('aria-invalid' in aria.controlProps).toBe(false);
    expect(aria.controlProps['aria-describedby']).toBe('barcode-warning');
  });

  it('treats a blank or whitespace-only warning as no warning', () => {
    expect(fieldAria('barcode', undefined, '').hasWarning).toBe(false);
    expect(fieldAria('barcode', undefined, '   ').hasWarning).toBe(false);
    expect(fieldAria('barcode', undefined, '   ').controlProps).toEqual({});
  });

  it('lets an error outrank a warning — only the error is wired', () => {
    const aria = fieldAria('barcode', 'Required', 'Check digit does not match');
    expect(aria.hasError).toBe(true);
    expect(aria.hasWarning).toBe(false);
    expect(aria.controlProps['aria-describedby']).toBe('barcode-error');
  });
});
