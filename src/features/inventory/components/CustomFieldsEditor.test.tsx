import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
    expect(screen.getByRole('spinbutton', { name: 'Voltage' })).toBeInTheDocument();
  });

  it('shows no info badge when the field has no description', () => {
    h.fields = [resolved({ description: null })];
    render(<CustomFieldsEditor itemId="item-1" />);
    expect(screen.queryByRole('img', { name: 'More information' })).not.toBeInTheDocument();
  });
});
