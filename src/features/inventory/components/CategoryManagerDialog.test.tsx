import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CategoryField, CategoryWithFieldCount } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * Behaviour tests for the {@link CategoryManagerDialog} glue (spec §4 Categories & Schema
 * Evolution). This is the schema-editing surface: it creates categories and defines their
 * dynamic custom fields, so an untested regression here corrupts the shape every item inherits.
 * Per the component-test conventions `../categories` and its six hooks are mocked (the preferences
 * store runs for real); this pins the dialog's decision logic — the create/select gates, the exact
 * `CreateCategoryFieldInput` assembled from the add-field form (SELECT choice parsing, blank
 * default → null, the required flag), the delete paths, and the datasheet-linking radio glue.
 */

const h = vi.hoisted(() => ({
  categoryRows: [] as CategoryWithFieldCount[],
  fields: [] as CategoryField[],
  createCategory: vi.fn(),
  createCategoryAsync: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  addField: vi.fn(),
  addFieldAsync: vi.fn(),
  deleteField: vi.fn(),
}));

vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: h.categoryRows } }),
  useCreateCategory: () => ({
    mutate: h.createCategory,
    mutateAsync: h.createCategoryAsync,
    isPending: false,
  }),
  useUpdateCategory: () => ({ mutate: h.updateCategory, isPending: false }),
  useDeleteCategory: () => ({ mutate: h.deleteCategory, isPending: false }),
  useCategoryFields: () => ({ data: h.fields }),
  useAddCategoryField: () => ({ mutate: h.addField, mutateAsync: h.addFieldAsync, isPending: false }),
  useDeleteCategoryField: () => ({ mutate: h.deleteField, isPending: false }),
}));

import { CategoryManagerDialog } from './CategoryManagerDialog';

const onClose = vi.fn();

const field = (overrides: Partial<CategoryField> = {}): CategoryField => ({
  id: 'f-1',
  categoryId: 'cat-1',
  name: 'Tolerance',
  fieldType: 'NUMBER',
  options: null,
  isRequired: true,
  defaultValue: null,
  position: 0,
  updatedAt: 0,
  ...overrides,
});

function renderDialog() {
  return render(<CategoryManagerDialog open onClose={onClose} />);
}

/** Open the detail pane for a category by clicking its row in the list. */
function selectCategory(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

const addFieldButton = () => screen.getByRole('button', { name: /Add field/ });

const category = (overrides: Partial<CategoryWithFieldCount> = {}): CategoryWithFieldCount => ({
  id: 'cat-1',
  name: 'Resistors',
  defaultTrackingMode: null,
  defaultCondition: null,
  defaultWarrantyMonths: null,
  updatedAt: 0,
  fieldCount: 1,
  ...overrides,
});

beforeEach(() => {
  h.categoryRows = [category()];
  h.fields = [field()];
  h.createCategory
    .mockReset()
    .mockImplementation((input, opts) =>
      opts?.onSuccess?.({ id: 'cat-new', name: input.name, fieldCount: 0 }),
    );
  h.createCategoryAsync.mockReset().mockResolvedValue({ id: 'cat-new' });
  h.updateCategory.mockReset();
  h.deleteCategory.mockReset();
  h.addField.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.addFieldAsync.mockReset().mockResolvedValue(undefined);
  h.deleteField.mockReset();
  onClose.mockReset();
  usePreferencesStore.setState({ attachmentMode: 'URL_ONLY' });
});
afterEach(cleanup);

describe('CategoryManagerDialog — creating a category', () => {
  it('disables Add until a name is typed, then creates it with the trimmed name', async () => {
    renderDialog();
    const addBtn = screen.getByRole('button', { name: 'Add category' });
    expect(addBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: '  Capacitors  ' } });
    expect(addBtn).toBeEnabled();
    fireEvent.click(addBtn);

    await waitFor(() =>
      expect(h.createCategory).toHaveBeenCalledWith({ name: 'Capacitors' }, expect.anything()),
    );
    // The name box clears after submitting.
    expect(screen.getByLabelText('New category name')).toHaveValue('');
  });

  it('creates via the Enter key too', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Diodes' } });
    fireEvent.keyDown(screen.getByLabelText('New category name'), { key: 'Enter' });

    await waitFor(() => expect(h.createCategory).toHaveBeenCalledWith({ name: 'Diodes' }, expect.anything()));
  });
});

describe('CategoryManagerDialog — the selected-category detail', () => {
  it('prompts to pick a category until one is selected', () => {
    renderDialog();
    expect(screen.getByText('Select a category to edit its fields.')).toBeInTheDocument();
  });

  it('lists the selected category fields with their type label and required marker', () => {
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByText('Tolerance')).toBeInTheDocument();
    expect(screen.getByText('Number')).toBeInTheDocument(); // FIELD_TYPE_LABELS.NUMBER
    // Required fields carry a trailing asterisk.
    expect(screen.getByText('Tolerance').textContent).toContain('*');
  });

  it('removes a field via its remove button', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove field Tolerance' }));
    expect(h.deleteField).toHaveBeenCalledWith('f-1');
  });

  it('deletes the category and returns to the empty prompt', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete category' }));
    expect(h.deleteCategory).toHaveBeenCalledWith('cat-1');
    expect(screen.getByText('Select a category to edit its fields.')).toBeInTheDocument();
  });
});

describe('CategoryManagerDialog — the add-field form assembles the input', () => {
  beforeEach(() => {
    renderDialog();
    selectCategory(/Resistors/);
  });

  it('disables Add field until a name is entered', () => {
    expect(addFieldButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    expect(addFieldButton()).toBeEnabled();
  });

  it('a plain TEXT field carries no options, a blank default becomes null, and the required flag rides along', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Required' }));
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        {
          categoryId: 'cat-1',
          input: { name: 'Voltage', fieldType: 'TEXT', isRequired: true, defaultValue: null, options: null },
        },
        expect.anything(),
      ),
    );
  });

  it('keeps a non-blank default value verbatim (trimmed)', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.change(screen.getByLabelText('Default value'), { target: { value: '  5V  ' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ defaultValue: '5V' }) }),
        expect.anything(),
      ),
    );
  });

  it('parses the comma-separated choices for a SELECT field, dropping blanks', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Colour' } });
    // Foundry Select is a custom listbox — open it and click the option (not selectOption).
    fireEvent.click(screen.getByRole('combobox', { name: 'Field type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Choice' }));
    // The Choices input only appears once the type is SELECT.
    fireEvent.change(screen.getByLabelText('Choices'), { target: { value: 'red, green, , blue ' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ fieldType: 'SELECT', options: ['red', 'green', 'blue'] }),
        }),
        expect.anything(),
      ),
    );
  });

  it('surfaces a failed add in an alert without clearing the form', async () => {
    h.addField.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('A field named "Voltage" exists.')),
    );
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('A field named "Voltage" exists.'),
    );
    expect(screen.getByLabelText('Field name')).toHaveValue('Voltage');
  });
});

describe('CategoryManagerDialog — the Default-value control matches the field type', () => {
  beforeEach(() => {
    renderDialog();
    selectCategory(/Resistors/);
  });

  it('resets the default value when switching field types', () => {
    fireEvent.change(screen.getByLabelText('Default value'), { target: { value: 'N/A' } });
    expect(screen.getByLabelText('Default value')).toHaveValue('N/A');

    fireEvent.click(screen.getByRole('combobox', { name: 'Field type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Number' }));

    expect((screen.getByLabelText('Default value') as HTMLInputElement).value).toBe('');
  });

  it('renders a Yes/No toggle for a Yes/No field, and submits the picked default', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'In stock' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Field type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Yes / No' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ fieldType: 'BOOLEAN', defaultValue: 'true' }),
        }),
        expect.anything(),
      ),
    );
  });

  it('renders a checkbox for an On/Off field', () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Field type' }));
    fireEvent.click(screen.getByRole('option', { name: 'On / Off' }));

    expect(screen.getByRole('checkbox', { name: 'Default value' })).toBeInTheDocument();
  });

  it('offers the live Choices list in the Default dropdown for a Choice field', () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Field type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Choice' }));
    fireEvent.change(screen.getByLabelText('Choices'), { target: { value: 'Red, Green' } });

    fireEvent.click(screen.getByRole('combobox', { name: 'Default value' }));
    expect(screen.getByRole('option', { name: 'Red' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Green' })).toBeInTheDocument();
  });
});

describe('CategoryManagerDialog — the new-item defaults editor (T3)', () => {
  beforeEach(() => {
    renderDialog();
    selectCategory(/Resistors/);
  });

  it('persists a chosen default tracking mode via the update mutation', async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking mode' }));
    fireEvent.click(screen.getByRole('option', { name: 'Serialised' }));

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultTrackingMode: 'SERIALISED' },
      }),
    );
  });

  it('persists a chosen default condition via the update mutation', async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Condition' }));
    fireEvent.click(screen.getByRole('option', { name: 'Good' }));

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultCondition: 'GOOD' },
      }),
    );
  });

  it('persists a typed default warranty window via the update mutation', async () => {
    fireEvent.change(screen.getByLabelText('Default warranty in months'), { target: { value: '12' } });

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultWarrantyMonths: 12 },
      }),
    );
  });

  it('clears a default tracking mode to null when picking — No default —', async () => {
    // Start from a category that already carries a default so there is something to clear.
    cleanup();
    h.categoryRows = [category({ defaultTrackingMode: 'SERIALISED' })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByRole('combobox', { name: 'Tracking mode' }));
    fireEvent.click(screen.getByRole('option', { name: '— No default —' }));

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultTrackingMode: null },
      }),
    );
  });

  it('clears the default warranty window to null when the field is emptied', async () => {
    cleanup();
    h.categoryRows = [category({ defaultWarrantyMonths: 24 })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = screen.getByLabelText('Default warranty in months');
    expect(input).toHaveValue(24);
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultWarrantyMonths: null },
      }),
    );
  });
});

describe('CategoryManagerDialog — the Tools starter affordance (T4)', () => {
  const toolsButton = () => screen.queryByRole('button', { name: 'Add a Tools category' });

  it('seeds a Tools category with its T1/T2 defaults and both tool-ish fields, in order', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Add a Tools category' }));

    await waitFor(() =>
      expect(h.createCategoryAsync).toHaveBeenCalledWith({
        name: 'Tools',
        defaultTrackingMode: 'SERIALISED',
        defaultCondition: 'GOOD',
        defaultWarrantyMonths: 12,
      }),
    );
    await waitFor(() => expect(h.addFieldAsync).toHaveBeenCalledTimes(2));
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(1, {
      categoryId: 'cat-new',
      input: { name: 'Serial number', fieldType: 'TEXT', position: 0 },
    });
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(2, {
      categoryId: 'cat-new',
      input: { name: 'Calibration certificate', fieldType: 'URL', position: 1 },
    });
  });

  it('hides the affordance when a Tools category already exists (idempotent — no duplicate)', () => {
    cleanup();
    h.categoryRows = [category({ name: 'Tools' })];
    renderDialog();
    expect(toolsButton()).not.toBeInTheDocument();
  });

  it('matches an existing Tools category case-insensitively', () => {
    cleanup();
    h.categoryRows = [category({ name: '  tools  ' })];
    renderDialog();
    expect(toolsButton()).not.toBeInTheDocument();
  });
});

describe('CategoryManagerDialog — datasheet linking config', () => {
  it('switches the global attachment mode via the radio group', () => {
    renderDialog();
    expect(usePreferencesStore.getState().attachmentMode).toBe('URL_ONLY');
    fireEvent.click(screen.getByRole('radio', { name: 'URLs + local file pointers' }));
    expect(usePreferencesStore.getState().attachmentMode).toBe('HYBRID');
  });
});
