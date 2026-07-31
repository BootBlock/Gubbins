import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CategoryField, CategoryWithFieldCount, FieldDef } from '@/db/repositories';
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
  updateField: vi.fn(),
  deleteField: vi.fn(),
  unusedDefs: [] as FieldDef[],
  deleteUnusedFieldDef: vi.fn(),
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
  useUpdateCategoryField: () => ({ mutate: h.updateField, isPending: false }),
  useDeleteCategoryField: () => ({ mutate: h.deleteField, isPending: false }),
  useUnusedFieldDefs: () => ({ data: h.unusedDefs }),
  useDeleteUnusedFieldDef: () => ({
    mutate: h.deleteUnusedFieldDef,
    isPending: false,
    variables: undefined,
  }),
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
  description: null,
  dueLeadDays: null,
  unit: null,
  minValue: null,
  maxValue: null,
  prominence: null,
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
  defaultMaintenanceBasis: null,
  defaultMaintenanceIntervalDays: null,
  defaultMaintenanceIntervalUsage: null,
  hiddenCapabilities: [],
  fieldProminence: null,
  fieldTabLabel: null,
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
  h.updateField.mockReset();
  h.addFieldAsync.mockReset().mockResolvedValue(undefined);
  h.deleteField.mockReset();
  h.unusedDefs = [];
  h.deleteUnusedFieldDef.mockReset();
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
          input: {
            name: 'Voltage',
            fieldType: 'TEXT',
            isRequired: true,
            defaultValue: null,
            description: null,
            options: null,
            dueLeadDays: null,
            unit: null,
            minValue: null,
            maxValue: null,
            prominence: null,
          },
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

  it('carries a typed description (trimmed), and a blank one becomes null', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: '  Read from the label on the base.  ' },
    });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ description: 'Read from the label on the base.' }),
        }),
        expect.anything(),
      ),
    );
  });

  it('sends a null description when the field is left blank', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ description: null }) }),
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
    expect(input).toHaveValue('24');
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: { defaultWarrantyMonths: null },
      }),
    );
  });

  it('seeds a coherent TIME default maintenance schedule when the basis is first chosen (T2a)', async () => {
    // The interval field only appears once a basis is chosen (none set on this category).
    expect(screen.queryByLabelText('Default maintenance interval in days')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: 'Maintenance schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Time-based' }));

    // Picking the basis persists it together with a seeded (annual) day interval, never a no-op.
    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: {
          defaultMaintenanceBasis: 'TIME',
          defaultMaintenanceIntervalDays: 365,
          defaultMaintenanceIntervalUsage: null,
        },
      }),
    );
  });

  it('seeds a USAGE default onto the usage interval column (T2a)', async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Maintenance schedule' }));
    fireEvent.click(screen.getByRole('option', { name: 'Usage-based' }));

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: {
          defaultMaintenanceBasis: 'USAGE',
          defaultMaintenanceIntervalDays: null,
          defaultMaintenanceIntervalUsage: 100,
        },
      }),
    );
  });

  it('renders the day interval for a TIME category and persists an edited value (T2a)', async () => {
    cleanup();
    h.categoryRows = [category({ defaultMaintenanceBasis: 'TIME', defaultMaintenanceIntervalDays: 365 })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = screen.getByLabelText('Default maintenance interval in days');
    expect(input).toHaveValue('365');
    fireEvent.change(input, { target: { value: '90' } });

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: {
          defaultMaintenanceBasis: 'TIME',
          defaultMaintenanceIntervalDays: 90,
          defaultMaintenanceIntervalUsage: null,
        },
      }),
    );
  });

  it('labels the interval for a USAGE category and persists an edited value (T2a)', async () => {
    cleanup();
    h.categoryRows = [category({ defaultMaintenanceBasis: 'USAGE', defaultMaintenanceIntervalUsage: 100 })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = screen.getByLabelText('Default maintenance usage interval');
    expect(input).toHaveValue('100');
    fireEvent.change(input, { target: { value: '250' } });

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: {
          defaultMaintenanceBasis: 'USAGE',
          defaultMaintenanceIntervalDays: null,
          defaultMaintenanceIntervalUsage: 250,
        },
      }),
    );
  });

  it('clears the whole maintenance default when picking — No default — (T2a)', async () => {
    cleanup();
    h.categoryRows = [category({ defaultMaintenanceBasis: 'TIME', defaultMaintenanceIntervalDays: 365 })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByRole('combobox', { name: 'Maintenance schedule' }));
    fireEvent.click(screen.getByRole('option', { name: '— No default —' }));

    await waitFor(() =>
      expect(h.updateCategory).toHaveBeenCalledWith({
        id: 'cat-1',
        input: {
          defaultMaintenanceBasis: null,
          defaultMaintenanceIntervalDays: null,
          defaultMaintenanceIntervalUsage: null,
        },
      }),
    );
  });
});

describe('CategoryManagerDialog — the preset picker (importable categories)', () => {
  const openPicker = () => fireEvent.click(screen.getByRole('button', { name: 'Add from a preset…' }));

  it('imports the Tools preset with its defaults and all fields, in order', async () => {
    renderDialog();
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Add Tools preset' }));

    await waitFor(() =>
      expect(h.createCategoryAsync).toHaveBeenCalledWith({
        name: 'Tools',
        glyph: '🛠️',
        defaultTrackingMode: 'SERIALISED',
        defaultCondition: 'GOOD',
        defaultWarrantyMonths: 12,
      }),
    );
    await waitFor(() => expect(h.addFieldAsync).toHaveBeenCalledTimes(4));
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(1, {
      categoryId: 'cat-new',
      input: { name: 'Manufacturer', fieldType: 'TEXT', position: 0 },
    });
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(2, {
      categoryId: 'cat-new',
      input: { name: 'Model number', fieldType: 'TEXT', position: 1 },
    });
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(3, {
      categoryId: 'cat-new',
      input: { name: 'Serial number', fieldType: 'TEXT', position: 2 },
    });
    expect(h.addFieldAsync).toHaveBeenNthCalledWith(4, {
      categoryId: 'cat-new',
      input: { name: 'Calibration certificate', fieldType: 'URL', position: 3 },
    });
  });

  it('imports the Battery preset requested in the feature (its Voltage field rides along)', async () => {
    renderDialog();
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Add Battery preset' }));

    await waitFor(() => expect(h.createCategoryAsync).toHaveBeenCalledWith({ name: 'Battery', glyph: '🔋' }));
    await waitFor(() =>
      expect(h.addFieldAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ name: 'Voltage (V)', fieldType: 'NUMBER' }),
        }),
      ),
    );
  });

  it('marks an already-imported preset as Added and disables it (idempotent — no duplicate)', () => {
    cleanup();
    h.categoryRows = [category({ name: 'Tools' })];
    renderDialog();
    openPicker();
    expect(screen.getByRole('button', { name: 'Tools preset already added' })).toBeDisabled();
    // Battery is not present, so its card is still importable.
    expect(screen.getByRole('button', { name: 'Add Battery preset' })).toBeEnabled();
  });

  it('matches an existing preset category case-insensitively', () => {
    cleanup();
    h.categoryRows = [category({ name: '  tools  ' })];
    renderDialog();
    openPicker();
    expect(screen.getByRole('button', { name: 'Tools preset already added' })).toBeInTheDocument();
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

describe('CategoryManagerDialog — built-in field-name collision warning (#97 follow-up)', () => {
  const nameInput = () => screen.getByRole('textbox', { name: 'Field name' });

  it('warns when the typed name duplicates a built-in item field', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.change(nameInput(), { target: { value: 'Manufacturer' } });
    expect(screen.getByTestId('field-builtin-clash')).toHaveTextContent(/built-in Manufacturer/);
  });

  it('stays silent for a name that collides with nothing', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.change(nameInput(), { target: { value: 'Voltage' } });
    expect(screen.queryByTestId('field-builtin-clash')).toBeNull();
  });

  it('warns but never blocks — the field is still addable under the duplicate name', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.change(nameInput(), { target: { value: 'Manufacturer' } });

    expect(addFieldButton()).toBeEnabled();
    fireEvent.click(addFieldButton());
    expect(h.addField).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ name: 'Manufacturer' }) }),
      expect.anything(),
    );
  });
});

describe('CategoryManagerDialog — unused field definitions (#97 follow-up)', () => {
  const def = (overrides: Partial<FieldDef> = {}): FieldDef => ({
    id: 'def-1',
    name: 'Tolerance',
    fieldType: 'NUMBER',
    options: null,
    description: null,
    unit: null,
    minValue: null,
    maxValue: null,
    updatedAt: 0,
    ...overrides,
  });

  it('hides the whole section when the dictionary has no leftovers', () => {
    h.unusedDefs = [];
    renderDialog();
    expect(screen.queryByText('Unused custom fields')).toBeNull();
  });

  it('lists each unreferenced definition and removes the one asked for', () => {
    h.unusedDefs = [def(), def({ id: 'def-2', name: 'Legacy code', fieldType: 'TEXT' })];
    renderDialog();

    expect(screen.getByText('Unused custom fields')).toBeInTheDocument();
    expect(screen.getByText('Tolerance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove unused field Legacy code' }));
    expect(h.deleteUnusedFieldDef).toHaveBeenCalledWith('def-2');
  });
});

/**
 * Issue #618 — a category can declare the capabilities its items don't have, so those sections
 * stop cluttering every item of that kind. Ticking hides; the writes must be exact, because the
 * stored array is what every item in the category is then rendered against.
 */
describe('CategoryManagerDialog — sections a category hides', () => {
  const hideMaintenance = () => screen.getByTestId('category-hide-maintenance');

  it('offers a row per hideable capability, unticked when the category hides nothing', () => {
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByText('Sections these items don’t need')).toBeInTheDocument();
    expect(hideMaintenance()).not.toBeChecked();
  });

  it('writes the capability into the hidden set when ticked', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.click(hideMaintenance());
    expect(h.updateCategory).toHaveBeenCalledWith({
      id: 'cat-1',
      input: { hiddenCapabilities: ['maintenance'] },
    });
  });

  it('removes just that capability when unticked, leaving the others alone', () => {
    h.categoryRows = [category({ hiddenCapabilities: ['kits', 'maintenance'] })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(hideMaintenance()).toBeChecked();

    fireEvent.click(hideMaintenance());
    expect(h.updateCategory).toHaveBeenCalledWith({
      id: 'cat-1',
      input: { hiddenCapabilities: ['kits'] },
    });
  });

  it('says nothing about a maintenance conflict when the category adds no schedule', () => {
    h.categoryRows = [category({ hiddenCapabilities: ['maintenance'] })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.queryByTestId('category-hide-maintenance-conflict-clear')).toBeNull();
  });

  it('flags the contradiction when the category both adds a schedule and hides it', () => {
    // Left alone, this would create a schedule on every new item and immediately hide it.
    h.categoryRows = [
      category({
        hiddenCapabilities: ['maintenance'],
        defaultMaintenanceBasis: 'TIME',
        defaultMaintenanceIntervalDays: 365,
      }),
    ];
    renderDialog();
    selectCategory(/Resistors/);

    expect(screen.getByText(/also gives every new item a maintenance schedule/)).toBeInTheDocument();

    // The offered fix clears the schedule default rather than un-hiding the section, because
    // hiding it is the choice the user just made explicitly.
    fireEvent.click(screen.getByTestId('category-hide-maintenance-conflict-clear'));
    expect(h.updateCategory).toHaveBeenCalledWith({
      id: 'cat-1',
      input: {
        defaultMaintenanceBasis: null,
        defaultMaintenanceIntervalDays: null,
        defaultMaintenanceIntervalUsage: null,
      },
    });
  });
});

/**
 * Regression: the hidden-sections panel writes a *set* held in one column, so each toggle is a
 * read-modify-write of the whole value. Reading the base from the query cache lost ticks — the
 * write isn't optimistic, so a second toggle made before the refetch landed computed from the
 * pre-first-toggle array and silently dropped it. On a synced LWW column that discard would
 * propagate to other devices.
 */
describe('CategoryManagerDialog — hidden sections accumulate across quick toggles', () => {
  it('keeps the first tick when a second lands before the refetch', () => {
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByTestId('category-hide-maintenance'));
    // `h.categoryRows` is deliberately NOT updated: this is exactly the window where the cache
    // still holds the pre-click value.
    fireEvent.click(screen.getByTestId('category-hide-kits'));

    expect(h.updateCategory).toHaveBeenLastCalledWith({
      id: 'cat-1',
      input: { hiddenCapabilities: ['kits', 'maintenance'] },
    });
  });

  it('reseeds from the category when a different one is selected', () => {
    h.categoryRows = [category(), category({ id: 'cat-2', name: 'Movies', hiddenCapabilities: ['kits'] })];
    renderDialog();

    selectCategory(/Resistors/);
    expect(screen.getByTestId('category-hide-kits')).not.toBeChecked();

    selectCategory(/Movies/);
    expect(screen.getByTestId('category-hide-kits')).toBeChecked();
  });
});

/**
 * The DATE due-date opt-in (W1a). What matters here is that the *only* way to make a custom date
 * act like a deadline is deliberate, is offered on nothing else, and reaches an already-defined
 * field — an opt-in reachable only when creating one would strand every date field that already
 * exists, including the ones the preset library ships.
 */
describe('CategoryManagerDialog — the DATE due-date opt-in', () => {
  beforeEach(() => {
    h.categoryRows = [category()];
    renderDialog();
    selectCategory(/Resistors/);
  });

  it('offers the opt-in on a DATE field only', () => {
    expect(screen.queryByTestId('add-field-due-toggle')).toBeNull();
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    expect(screen.getByTestId('add-field-due-toggle')).toBeInTheDocument();
  });

  it('sends null unless the box is ticked, so an ordinary date still raises nothing', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Date acquired' } });
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ dueLeadDays: null }) }),
        expect.anything(),
      ),
    );
  });

  it('sends the notice period once ticked', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Renewal date' } });
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    fireEvent.click(screen.getByTestId('add-field-due-toggle'));
    fireEvent.change(screen.getByTestId('add-field-due-days'), { target: { value: '30' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ dueLeadDays: 30 }) }),
        expect.anything(),
      ),
    );
  });

  it('sends the default rather than 0 when the notice box is cleared before submitting', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Renewal date' } });
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    fireEvent.click(screen.getByTestId('add-field-due-toggle'));
    fireEvent.change(screen.getByTestId('add-field-due-days'), { target: { value: '' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ dueLeadDays: 14 }) }),
        expect.anything(),
      ),
    );
  });

  it('retracts the opt-in when the type moves off DATE, rather than sending a discarded tick', async () => {
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Renewal date' } });
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    fireEvent.click(screen.getByTestId('add-field-due-toggle'));
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Text' }));
    expect(screen.queryByTestId('add-field-due-toggle')).toBeNull();
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ dueLeadDays: null }) }),
        expect.anything(),
      ),
    );
  });
});

describe('CategoryManagerDialog — opting an existing DATE field in', () => {
  it('shows no due-date control on a field that is not a date', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER' })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.queryByTestId('field-due-toggle-f-1')).toBeNull();
  });

  it('ticking an existing date field stores the default notice period', () => {
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: null })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByTestId('field-due-toggle-f-1'));
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { dueLeadDays: 14 } },
      expect.anything(),
    );
  });

  it('unticking clears the opt-in entirely — the stored value IS the opt-in', () => {
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 30 })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByTestId('field-due-toggle-f-1'));
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { dueLeadDays: null } },
      expect.anything(),
    );
  });

  it('saves an edited notice period on blur, clamped into range', () => {
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 14 })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = screen.getByTestId('field-due-days-f-1');
    fireEvent.change(input, { target: { value: '9999' } });
    // Nothing is written mid-typing — the control is fed from server state.
    expect(h.updateField).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { dueLeadDays: 365 } },
      expect.anything(),
    );
  });

  it('reverts a cleared box instead of writing 0 — blank is not "notify on the day"', () => {
    // `Number('')` is 0 and 0 is a legal notice period, so coercing would silently reconfigure
    // the field the moment someone cleared the box to retype it, with nothing to flag it.
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 30 })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = screen.getByTestId('field-due-days-f-1');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(h.updateField).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('30');
  });

  it('re-seats the box when the stored value changes underneath it', () => {
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 14 })];
    const view = renderDialog();
    selectCategory(/Resistors/);
    expect((screen.getByTestId('field-due-days-f-1') as HTMLInputElement).value).toBe('14');

    // Another category editing the shared definition, or a peer's sync.
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 60 })];
    view.rerender(<CategoryManagerDialog open onClose={onClose} />);

    expect((screen.getByTestId('field-due-days-f-1') as HTMLInputElement).value).toBe('60');
  });

  it('does not write when the blurred value is unchanged', () => {
    h.categoryRows = [category()];
    h.fields = [field({ name: 'Renewal date', fieldType: 'DATE', dueLeadDays: 14 })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.blur(screen.getByTestId('field-due-days-f-1'));
    expect(h.updateField).not.toHaveBeenCalled();
  });
});

/**
 * Custom-field prominence (issue #619) — where the category's fields sit on an item. Unlike the
 * hidden-sections panel above this changes nothing about *what* exists, so the panel's whole job
 * is to write one of three modes plus an optional tab name, and to surface the one contradiction
 * a user can construct (promoting fields the same category also hides).
 */
describe('CategoryManagerDialog — where the custom fields go', () => {
  const radio = (mode: string) => screen.getByTestId(`category-field-prominence-${mode}`);
  const tabNameInput = () => screen.queryByTestId('category-field-tab-label');

  it('offers the three positions, with the default selected when nothing is stored', () => {
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByText('Where the custom fields go')).toBeInTheDocument();
    expect(radio('default')).toBeChecked();
    expect(radio('promoted')).not.toBeChecked();
    expect(radio('own-tab')).not.toBeChecked();
  });

  it('reads an unrecognised stored mode as the default rather than leaving nothing selected', () => {
    // A peer on a newer version may store a fourth position; the panel must still be usable.
    h.categoryRows = [category({ fieldProminence: 'floating-panel' })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(radio('default')).toBeChecked();
  });

  it('saves the chosen mode immediately', () => {
    renderDialog();
    selectCategory(/Resistors/);
    fireEvent.click(radio('promoted'));
    expect(h.updateCategory).toHaveBeenCalledWith({ id: 'cat-1', input: { fieldProminence: 'promoted' } });
  });

  it('offers a tab name only for the mode that creates a tab', () => {
    renderDialog();
    selectCategory(/Resistors/);
    expect(tabNameInput()).toBeNull();

    // The radio is driven from the persisted value, so the panel only shows the field once the
    // category actually reads back as `own-tab` — mirror that rather than faking local state.
    h.categoryRows = [category({ fieldProminence: 'promoted' })];
    cleanup();
    renderDialog();
    selectCategory(/Resistors/);
    expect(tabNameInput()).toBeNull();

    h.categoryRows = [category({ fieldProminence: 'own-tab' })];
    cleanup();
    renderDialog();
    selectCategory(/Resistors/);
    expect(tabNameInput()).toBeInTheDocument();
  });

  it('saves the tab name as it is typed, and shows the built-in label as the placeholder', () => {
    h.categoryRows = [category({ fieldProminence: 'own-tab' })];
    renderDialog();
    selectCategory(/Resistors/);

    const input = tabNameInput()!;
    expect(input).toHaveAttribute('placeholder', 'Custom fields');
    fireEvent.change(input, { target: { value: 'Film details' } });
    expect(h.updateCategory).toHaveBeenCalledWith({
      id: 'cat-1',
      input: { fieldTabLabel: 'Film details' },
    });
  });

  it('shows the stored tab name, and reseeds it when a different category is selected', () => {
    h.categoryRows = [
      category({ fieldProminence: 'own-tab', fieldTabLabel: 'Film details' }),
      category({ id: 'cat-2', name: 'Vinyl', fieldProminence: 'own-tab', fieldTabLabel: 'Pressing' }),
    ];
    renderDialog();

    selectCategory(/Resistors/);
    expect(tabNameInput()).toHaveValue('Film details');

    selectCategory(/Vinyl/);
    expect(tabNameInput()).toHaveValue('Pressing');
  });

  it('says nothing about a conflict while the fields stay where they are', () => {
    h.categoryRows = [category({ hiddenCapabilities: ['custom-fields'] })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.queryByTestId('category-field-prominence-conflict-clear')).toBeNull();
  });

  it('flags the contradiction when the category both promotes and hides its custom fields', () => {
    h.categoryRows = [
      category({ hiddenCapabilities: ['custom-fields', 'kits'], fieldProminence: 'own-tab' }),
    ];
    renderDialog();
    selectCategory(/Resistors/);

    expect(screen.getByText(/also hides its custom fields/)).toBeInTheDocument();

    // The offered fix un-hides the fields rather than dropping the position, because asking for a
    // tab of their own is the choice the user just made explicitly. Other hidden sections stay.
    fireEvent.click(screen.getByTestId('category-field-prominence-conflict-clear'));
    expect(h.updateCategory).toHaveBeenCalledWith({
      id: 'cat-1',
      input: { hiddenCapabilities: ['kits'] },
    });
  });

  /**
   * Both this panel and the hidden-sections panel write `hiddenCapabilities`, and the write is not
   * optimistic. They therefore share one draft: two independent buffers would let each recompute
   * from a base the other had already moved, dropping a change on a synced LWW column.
   */
  it('computes the conflict fix from a tick made moments earlier, not from the stale cache', () => {
    h.categoryRows = [category({ hiddenCapabilities: ['custom-fields'], fieldProminence: 'own-tab' })];
    renderDialog();
    selectCategory(/Resistors/);

    // Hide another section. `h.categoryRows` is deliberately NOT updated — this is the window
    // where the query cache still holds the pre-click value.
    fireEvent.click(screen.getByTestId('category-hide-kits'));
    fireEvent.click(screen.getByTestId('category-field-prominence-conflict-clear'));

    expect(h.updateCategory).toHaveBeenLastCalledWith({
      id: 'cat-1',
      input: { hiddenCapabilities: ['kits'] },
    });
  });

  it('clears the sibling panel’s tick and its own banner when the fix is applied', () => {
    // The other direction: with separate drafts the checkbox above would stay ticked for the rest
    // of the session and write `custom-fields` straight back on the next unrelated toggle.
    h.categoryRows = [category({ hiddenCapabilities: ['custom-fields'], fieldProminence: 'promoted' })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByTestId('category-hide-custom-fields')).toBeChecked();

    fireEvent.click(screen.getByTestId('category-field-prominence-conflict-clear'));

    expect(screen.getByTestId('category-hide-custom-fields')).not.toBeChecked();
    expect(screen.queryByTestId('category-field-prominence-conflict-clear')).toBeNull();
  });
});

describe('CategoryManagerDialog — a number field’s unit and range (W1b/W1c)', () => {
  it('offers the controls on a NUMBER field only', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'TEXT' })];
    const view = renderDialog();
    selectCategory(/Resistors/);
    expect(screen.queryByTestId('field-unit-f-1')).toBeNull();
    expect(screen.queryByTestId('field-min-f-1')).toBeNull();

    h.fields = [field({ fieldType: 'NUMBER' })];
    view.rerender(<CategoryManagerDialog open onClose={onClose} />);
    expect(screen.getByTestId('field-unit-f-1')).toBeInTheDocument();
    expect(screen.getByTestId('field-max-f-1')).toBeInTheDocument();
  });

  it('seeds the boxes from the stored definition', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', unit: 'V', minValue: 0, maxValue: 24 })];
    renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByTestId('field-unit-f-1')).toHaveValue('V');
    expect(screen.getByTestId('field-min-f-1')).toHaveValue('0');
    expect(screen.getByTestId('field-max-f-1')).toHaveValue('24');
  });

  it('saves a typed unit on blur, not per keystroke', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', unit: null })];
    renderDialog();
    selectCategory(/Resistors/);

    const box = screen.getByTestId('field-unit-f-1');
    fireEvent.change(box, { target: { value: 'mm' } });
    expect(h.updateField).not.toHaveBeenCalled();

    fireEvent.blur(box);
    expect(h.updateField).toHaveBeenCalledWith({ fieldId: 'f-1', input: { unit: 'mm' } }, expect.anything());
  });

  it('clears the unit when the box is emptied — a blank unit is “unitless”', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', unit: 'V' })];
    renderDialog();
    selectCategory(/Resistors/);

    const box = screen.getByTestId('field-unit-f-1');
    fireEvent.change(box, { target: { value: '  ' } });
    fireEvent.blur(box);
    expect(h.updateField).toHaveBeenCalledWith({ fieldId: 'f-1', input: { unit: null } }, expect.anything());
  });

  it('sends only the end of the range that was edited', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', minValue: null, maxValue: 24 })];
    renderDialog();
    selectCategory(/Resistors/);

    const min = screen.getByTestId('field-min-f-1');
    fireEvent.change(min, { target: { value: '3' } });
    fireEvent.blur(min);
    expect(h.updateField).toHaveBeenCalledWith({ fieldId: 'f-1', input: { minValue: 3 } }, expect.anything());
  });

  it('clears a bound when its box is emptied — blank means unbounded, not zero', () => {
    // The opposite rule to the due-date notice period, where blank had to revert. Here the empty
    // box has its own meaning, so coercing it to 0 would invent a floor nobody asked for.
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', minValue: 5 })];
    renderDialog();
    selectCategory(/Resistors/);

    const min = screen.getByTestId('field-min-f-1');
    fireEvent.change(min, { target: { value: '' } });
    fireEvent.blur(min);
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { minValue: null } },
      expect.anything(),
    );
  });

  it('reverts an un-parseable bound instead of clearing the stored one', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', minValue: 5 })];
    renderDialog();
    selectCategory(/Resistors/);

    const min = screen.getByTestId('field-min-f-1');
    fireEvent.change(min, { target: { value: '-' } });
    fireEvent.blur(min);
    expect(h.updateField).not.toHaveBeenCalled();
    expect(min).toHaveValue('5');
  });

  it('does not write when the blurred value is unchanged', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', unit: 'V', maxValue: 24 })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.blur(screen.getByTestId('field-unit-f-1'));
    fireEvent.blur(screen.getByTestId('field-max-f-1'));
    expect(h.updateField).not.toHaveBeenCalled();
  });

  it('re-seats the boxes when the stored definition changes underneath them', () => {
    h.categoryRows = [category()];
    h.fields = [field({ fieldType: 'NUMBER', unit: 'V', maxValue: 24 })];
    const view = renderDialog();
    selectCategory(/Resistors/);

    h.fields = [field({ fieldType: 'NUMBER', unit: 'mV', maxValue: 5000 })];
    view.rerender(<CategoryManagerDialog open onClose={onClose} />);
    expect(screen.getByTestId('field-unit-f-1')).toHaveValue('mV');
    expect(screen.getByTestId('field-max-f-1')).toHaveValue('5000');
  });

  it('sends the add form’s unit and range only for a NUMBER field', async () => {
    h.categoryRows = [category()];
    h.fields = [];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Number' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.change(screen.getByTestId('add-field-unit'), { target: { value: 'V' } });
    fireEvent.change(screen.getByTestId('add-field-max'), { target: { value: '24' } });
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ unit: 'V', minValue: null, maxValue: 24 }),
        }),
        expect.anything(),
      ),
    );
  });

  it('retracts a typed unit and range when the type moves off Number', async () => {
    // Otherwise the submit would silently discard what the user typed, with the boxes gone and
    // nothing to say the values went with them.
    h.categoryRows = [category()];
    h.fields = [];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Number' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Voltage' } });
    fireEvent.change(screen.getByTestId('add-field-unit'), { target: { value: 'V' } });

    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Text' }));
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ unit: null, minValue: null, maxValue: null }),
        }),
        expect.anything(),
      ),
    );
  });
});

/**
 * W1d - the per-definition key-field mark. Offered on every field type, unlike the due-date
 * opt-in and the number settings, and saved straight onto the shared dictionary definition.
 */
describe('CategoryManagerDialog - the key-field mark (W1d)', () => {
  it('offers the tick on every field type, not just one', () => {
    h.categoryRows = [category()];
    for (const fieldType of ['TEXT', 'DATE', 'NUMBER', 'SELECT'] as const) {
      h.fields = [field({ fieldType, options: fieldType === 'SELECT' ? ['A'] : null })];
      const view = renderDialog();
      selectCategory(/Resistors/);
      expect(screen.getByTestId('field-key-toggle-f-1')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('reflects the stored rank, reading an unrecognised mode as unticked', () => {
    h.categoryRows = [category()];
    h.fields = [field({ prominence: 'key' })];
    const view = renderDialog();
    selectCategory(/Resistors/);
    expect(screen.getByTestId('field-key-toggle-f-1')).toBeChecked();

    h.fields = [field({ prominence: 'trailing' })];
    view.rerender(<CategoryManagerDialog open onClose={onClose} />);
    expect(screen.getByTestId('field-key-toggle-f-1')).not.toBeChecked();
  });

  it('saves the mark immediately - a tick has no half-typed state to race the refetch', () => {
    h.categoryRows = [category()];
    h.fields = [field({ prominence: null })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByTestId('field-key-toggle-f-1'));
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { prominence: 'key' } },
      expect.anything(),
    );
  });

  it("clears the mark as 'default' rather than as a bare null", () => {
    h.categoryRows = [category()];
    h.fields = [field({ prominence: 'key' })];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.click(screen.getByTestId('field-key-toggle-f-1'));
    expect(h.updateField).toHaveBeenCalledWith(
      { fieldId: 'f-1', input: { prominence: 'default' } },
      expect.anything(),
    );
  });

  it('adds a new field marked, and sends null rather than a demotion when unticked', async () => {
    // `null` on the add path matters: the name may resolve to a definition another category
    // already marked, and an omission leaves that alone where 'default' would clear it.
    h.categoryRows = [category()];
    h.fields = [];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Movement' } });
    fireEvent.click(addFieldButton());
    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ prominence: null }) }),
        expect.anything(),
      ),
    );

    h.addField.mockClear();
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Reference' } });
    fireEvent.click(screen.getByTestId('add-field-key'));
    fireEvent.click(addFieldButton());
    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ prominence: 'key' }) }),
        expect.anything(),
      ),
    );
  });

  it('keeps the mark across a type change, because it is not gated on the type', async () => {
    // The contrast with the unit and the range, which the type Select deliberately clears.
    h.categoryRows = [category()];
    h.fields = [];
    renderDialog();
    selectCategory(/Resistors/);

    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Movement' } });
    fireEvent.click(screen.getByTestId('add-field-key'));
    fireEvent.click(screen.getByLabelText('Field type'));
    fireEvent.click(screen.getByRole('option', { name: 'Date' }));
    fireEvent.click(addFieldButton());

    await waitFor(() =>
      expect(h.addField).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ prominence: 'key' }) }),
        expect.anything(),
      ),
    );
  });
});
