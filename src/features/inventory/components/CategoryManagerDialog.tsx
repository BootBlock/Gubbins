import { useState } from 'react';
import {
  Button,
  Checkbox,
  FormField,
  Input,
  InfoHint,
  Modal,
  SelectField,
  Tooltip,
  INFO_OPEN_DELAY_MS,
} from '@/components/foundry';
import { AddIcon, CloseIcon, DeleteIcon, InfoIcon } from '@/components/icons';
import { FIELD_TYPES, type CategoryWithFieldCount, type FieldType } from '@/db/repositories';
import { usePreferencesStore, type AttachmentMode } from '@/state/stores/usePreferencesStore';
import {
  useAddCategoryField,
  useCategories,
  useCategoryFields,
  useCreateCategory,
  useDeleteCategory,
  useDeleteCategoryField,
} from '../categories';
import { ATTACHMENT_MODE_LABELS, FIELD_TYPE_LABELS } from './inventory-ui';
import { TypedFieldControl } from './TypedFieldControl';

/**
 * Category & schema manager (spec §4). Create categories, define their dynamic
 * custom fields, and configure the global datasheet-linking mode (Option A/B).
 */
export function CategoryManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Categories & schemas"
      description="Group items into categories, and give each one a custom schema of extra fields."
      className="max-w-3xl"
    >
      <p className="mb-4 text-xs text-muted-foreground">
        A category is a label you assign to items (e.g. "Cables", "Fasteners"). Its
        <span className="font-medium text-foreground"> schema</span> is the set of custom fields you add below
        — say, <span className="font-medium text-foreground">Voltage</span> or{' '}
        <span className="font-medium text-foreground">Warranty expiry</span> — which then appear on every item
        in that category, alongside the built-in fields every item already has. Nothing here is required:
        items without a category just skip this step.
      </p>
      <CategoryManagerBody />
      <DatasheetLinkingConfig />
    </Modal>
  );
}

function CategoryManagerBody() {
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  const [newName, setNewName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = categories?.rows ?? [];
  const selected = rows.find((c) => c.id === selectedId) ?? null;

  const addCategory = () => {
    const name = newName.trim();
    if (!name) return;
    createCategory.mutate({ name }, { onSuccess: (cat) => setSelectedId(cat.id) });
    setNewName('');
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_1fr]">
      {/* Category list */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())}
            placeholder="New category…"
            aria-label="New category name"
            className="flex-1"
          />
          <InfoHint content="A category is a label you assign to items — e.g. **Cables**, **Fasteners** — so you can give its members their own custom fields on the right." />
          <Tooltip
            content="Create the category, then define its custom fields on the right."
            triggerTabIndex={-1}
          >
            <span>
              <Button size="icon" aria-label="Add category" onClick={addCategory} disabled={!newName.trim()}>
                <AddIcon />
              </Button>
            </span>
          </Tooltip>
        </div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-1 py-2 text-xs text-muted-foreground">No categories yet.</li>
          ) : (
            rows.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(cat.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                    cat.id === selectedId ? 'bg-primary/15 text-primary' : 'hover:bg-secondary'
                  }`}
                >
                  <span className="truncate">{cat.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">{cat.fieldCount}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Selected category detail */}
      <div className="min-w-0">
        {selected ? (
          <CategoryDetail
            category={selected}
            onDeleted={() => {
              deleteCategory.mutate(selected.id);
              setSelectedId(null);
            }}
          />
        ) : (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            Select a category to edit its fields.
          </p>
        )}
      </div>
    </div>
  );
}

function CategoryDetail({
  category,
  onDeleted,
}: {
  category: CategoryWithFieldCount;
  onDeleted: () => void;
}) {
  const { data: fields } = useCategoryFields(category.id);
  const deleteField = useDeleteCategoryField();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold">{category.name}</h3>
        <Tooltip
          content="Delete this category and all its field definitions. Items keep their stored values."
          triggerTabIndex={-1}
        >
          <span>
            <Button variant="ghost" size="icon" aria-label="Delete category" onClick={onDeleted}>
              <DeleteIcon className="text-glyph-danger" />
            </Button>
          </span>
        </Tooltip>
      </div>

      <ul className="space-y-1">
        {(fields ?? []).length === 0 ? (
          <li className="text-xs text-muted-foreground">No fields. Add one below.</li>
        ) : (
          fields!.map((field) => (
            <li
              key={field.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-2.5 py-1.5 text-sm"
            >
              <span className="flex-1 truncate">
                {field.name}
                {field.isRequired ? <span className="text-destructive"> *</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {FIELD_TYPE_LABELS[field.fieldType]}
              </span>
              <button
                type="button"
                aria-label={`Remove field ${field.name}`}
                onClick={() => deleteField.mutate(field.id)}
                className="rounded p-0.5 transition-colors hover:bg-secondary [&_svg]:size-3.5"
              >
                <CloseIcon className="text-glyph-danger" />
              </button>
            </li>
          ))
        )}
      </ul>

      <AddFieldForm categoryId={category.id} />
    </div>
  );
}

/** Comma-separated Choices text → the trimmed, non-blank option list. */
function parseChoices(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function AddFieldForm({ categoryId }: { categoryId: string }) {
  const addField = useAddCategoryField();
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>('TEXT');
  const [options, setOptions] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [defaultValue, setDefaultValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    addField.mutate(
      {
        categoryId,
        input: {
          name,
          fieldType,
          isRequired,
          defaultValue: defaultValue.trim() || null,
          options: fieldType === 'SELECT' ? parseChoices(options) : null,
        },
      },
      {
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the field.'),
        onSuccess: () => {
          setName('');
          setOptions('');
          setDefaultValue('');
          setIsRequired(false);
        },
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/10 p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Field name"
          hint="The label for this field, shown on every item in this category — and as the column header if you export to CSV. Keep it short and specific, e.g. **Voltage**, **Warranty expiry**, **Colour**."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Voltage"
            aria-label="Field name"
          />
        </FormField>
        <SelectField
          label="Field type"
          hint={`What kind of value this field holds — it controls the control shown on the item and the validation applied when saving:

- **Text** – a single line of free text.
- **Long text** – multi-line notes.
- **URL / Link** – a validated web address (e.g. a datasheet page).
- **Number** – any numeric value, decimals allowed.
- **Rating (1–5)** – a whole number from 1 to 5.
- **Yes / No** – a two-button toggle.
- **On / Off** – a checkbox — identical to Yes/No, just worded (and shown) differently.
- **Date** – a calendar date.
- **Choice** – one of a fixed list you define below.`}
          hintSize="md"
          value={fieldType}
          onChange={(value) => {
            // A default typed for the old field type rarely still makes sense for the
            // new one (e.g. free text becoming a date) — start it fresh.
            setFieldType(value as FieldType);
            setDefaultValue('');
          }}
          options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))}
        />
      </div>
      {fieldType === 'SELECT' ? (
        <FormField
          label="Choices"
          hint="The options this field can be set to, separated by commas — e.g. `Red, Green, Blue`. Shown as a dropdown on each item."
        >
          <Input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Red, Green, Blue"
            aria-label="Choices"
          />
        </FormField>
      ) : null}
      <FormField
        label="Default value"
        hint="Shown for an item in this category that hasn't set this field yet (lenient defaulting) — it's never written to existing items, only displayed until they get their own value. Matches the control shown on the item itself."
      >
        <TypedFieldControl
          fieldType={fieldType}
          value={defaultValue}
          onChange={setDefaultValue}
          options={fieldType === 'SELECT' ? parseChoices(options) : null}
          ariaLabel="Default value"
        />
      </FormField>
      <div className="flex items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          Required
        </label>
        <InfoHint content="When on, an item in this category must have a value for this field before its custom fields can be saved." />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!name.trim() || addField.isPending}>
          <AddIcon />
          Add field
        </Button>
      </div>
    </div>
  );
}

function DatasheetLinkingConfig() {
  const mode = usePreferencesStore((s) => s.attachmentMode);
  const setMode = usePreferencesStore((s) => s.setAttachmentMode);

  return (
    <div className="mt-5 rounded-xl border border-border bg-secondary/10 p-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        Datasheet linking
        <Tooltip
          content="**Option A** links external URLs only. **Option B** also lets you point at local PDFs — only the file *path* is stored and synced, never the file itself (§4)."
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span className="text-muted-foreground [&_svg]:size-3.5">
            <InfoIcon />
          </span>
        </Tooltip>
      </h3>
      <div className="space-y-1.5">
        {(Object.keys(ATTACHMENT_MODE_LABELS) as AttachmentMode[]).map((m) => (
          <label key={m} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="attachment-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
              className="size-3.5 accent-primary"
            />
            {ATTACHMENT_MODE_LABELS[m]}
          </label>
        ))}
      </div>
    </div>
  );
}
