import { useState } from 'react';
import { Button, Input, Modal, Select, Tooltip } from '@/components/foundry';
import { AddIcon, CloseIcon, DeleteIcon, InfoIcon } from '@/components/icons';
import { FIELD_TYPES, type CategoryWithFieldCount, type FieldType } from '@/db/repositories';
import {
  usePreferencesStore,
  type AttachmentMode,
} from '@/state/stores/usePreferencesStore';
import {
  useAddCategoryField,
  useCategories,
  useCategoryFields,
  useCreateCategory,
  useDeleteCategory,
  useDeleteCategoryField,
} from '../categories';
import { ATTACHMENT_MODE_LABELS, FIELD_TYPE_LABELS } from './inventory-ui';

/**
 * Category & schema manager (spec §4). Create categories, define their dynamic
 * custom fields, and configure the global datasheet-linking mode (Option A/B).
 */
export function CategoryManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    createCategory.mutate(
      { name },
      { onSuccess: (cat) => setSelectedId(cat.id) },
    );
    setNewName('');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Categories & schemas"
      description="Define categories, their custom fields, and datasheet linking."
      className="max-w-3xl"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_1fr]">
        {/* Category list */}
        <div className="space-y-2">
          <div className="flex gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())}
              placeholder="New category…"
              aria-label="New category name"
            />
            <Button size="icon" aria-label="Add category" onClick={addCategory} disabled={!newName.trim()}>
              <AddIcon />
            </Button>
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

      <DatasheetLinkingConfig />
    </Modal>
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
        <Button variant="ghost" size="icon" aria-label="Delete category" onClick={onDeleted}>
          <DeleteIcon />
        </Button>
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
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive [&_svg]:size-3.5"
              >
                <CloseIcon />
              </button>
            </li>
          ))
        )}
      </ul>

      <AddFieldForm categoryId={category.id} />
    </div>
  );
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
          options:
            fieldType === 'SELECT'
              ? options.split(',').map((o) => o.trim()).filter(Boolean)
              : null,
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
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Field name" aria-label="Field name" />
        <Select value={fieldType} onChange={(e) => setFieldType(e.target.value as FieldType)} aria-label="Field type">
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>
      {fieldType === 'SELECT' ? (
        <Input
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          placeholder="Choices, comma-separated"
          aria-label="Choices"
        />
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          value={defaultValue}
          onChange={(e) => setDefaultValue(e.target.value)}
          placeholder="Default (optional)"
          aria-label="Default value"
          className="flex-1"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Required
        </label>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
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
        <Tooltip content="**Option A** links external URLs only. **Option B** also lets you point at local PDFs — only the file *path* is stored and synced, never the file itself (§4).">
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
