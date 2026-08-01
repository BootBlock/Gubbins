import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ResolvedItemField } from '@/db/repositories';

/**
 * Behaviour tests for {@link CustomFieldsEditor} — the per-item custom-field control on the
 * item dialog. This pins the field **Description** surface (issue #106): a field whose
 * definition carries a description shows an info badge beside its label; one without shows
 * none. Per the component-test conventions `../categories` and its two hooks are mocked.
 */

const h = vi.hoisted(() => ({
  fields: [] as ResolvedItemField[],
  setValues: vi.fn(),
}));

vi.mock('../categories', () => ({
  useItemFields: () => ({ data: h.fields, isLoading: false }),
  useSetItemFieldValues: () => ({ mutate: h.setValues, isPending: false }),
}));

/** Pin this device so the W1g attribution comparison is decidable. */
vi.mock('@/lib/env/device-id', () => ({ getDeviceId: () => 'device-this' }));

import { CustomFieldsEditor } from './CustomFieldsEditor';

const resolved = (overrides: Partial<ResolvedItemField> = {}): ResolvedItemField => ({
  id: 'f-1',
  categoryId: 'cat-1',
  name: 'Voltage',
  fieldType: 'NUMBER',
  options: null,
  isRequired: false,
  defaultValue: null,
  description: null,
  unit: null,
  minValue: null,
  maxValue: null,
  position: 0,
  updatedAt: 0,
  value: null,
  hasStoredValue: false,
  ...overrides,
});

beforeEach(() => {
  h.fields = [];
  h.setValues.mockReset();
});
afterEach(cleanup);

describe('CustomFieldsEditor — the field description info hint', () => {
  it('shows an info badge for a field carrying a description', () => {
    h.fields = [resolved({ description: 'Read from the label on the base.' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.getByRole('img', { name: 'More information' })).toBeInTheDocument();
  });

  it('keeps the badge out of the control accessible name', () => {
    // The badge carries its own name ("More information"); it must not leak into the
    // field control's accessible name, which stays the bare field name.
    h.fields = [resolved({ name: 'Voltage', description: 'Read from the label on the base.' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.getByRole('textbox', { name: 'Voltage' })).toBeInTheDocument();
  });

  it('shows no info badge when the field has no description', () => {
    h.fields = [resolved({ description: null })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.queryByRole('img', { name: 'More information' })).not.toBeInTheDocument();
  });
});

/**
 * W1g — a `FILE` value holding a path recorded on another device. The editor is where that
 * gets fixed, so it is the surface that has to say so and the write that has to re-home it.
 */
describe('CustomFieldsEditor — a file path from another device (W1g)', () => {
  const PATH = '\\\\server\\share\\boiler.pdf';
  const HINT = /recorded on another device/i;

  const fileField = (overrides: Partial<ResolvedItemField> = {}): ResolvedItemField =>
    resolved({ name: 'Manual', fieldType: 'FILE', value: PATH, hasStoredValue: true, ...overrides });

  it('explains a value recorded elsewhere, beside the box that re-links it', () => {
    h.fields = [fileField({ originDeviceId: 'device-other' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it.each([
    ['recorded on this device', 'device-this'],
    ['unattributed', null],
  ])('says nothing about a path %s', (_label, originDeviceId) => {
    h.fields = [fileField({ originDeviceId })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('says nothing about a FILE value holding a web address, whoever recorded it', () => {
    // An address opens on any device, so where it was typed is not worth a warning.
    h.fields = [fileField({ value: 'https://example.com/boiler.pdf', originDeviceId: 'device-other' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('drops the note as soon as the user types a replacement', () => {
    // It describes the *stored* value; once the draft differs, it is about to stop being true.
    h.fields = [fileField({ originDeviceId: 'device-other' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual' }), {
      target: { value: 'D:\\manuals\\boiler.pdf' },
    });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('attributes the save to this device, which is what re-homes the path', () => {
    h.fields = [fileField({ originDeviceId: 'device-other' })];
    render(<CustomFieldsEditor itemId="item-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual' }), {
      target: { value: 'D:\\manuals\\boiler.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(h.setValues).toHaveBeenCalledWith({
      values: { 'f-1': 'D:\\manuals\\boiler.pdf' },
      originDeviceId: 'device-this',
    });
  });
});
