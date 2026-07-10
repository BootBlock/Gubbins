import { useEffect, useState } from 'react';
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
import { AddIcon, CloseIcon, DeleteIcon, InfoIcon, ToolsIcon } from '@/components/icons';
import {
  FIELD_TYPES,
  MAINTENANCE_BASES,
  TRACKING_MODES,
  type CategoryWithFieldCount,
  type Condition,
  type FieldType,
  type MaintenanceBasis,
  type TrackingMode,
} from '@/db/repositories';
import { usePreferencesStore, type AttachmentMode } from '@/state/stores/usePreferencesStore';
import {
  useAddCategoryField,
  useCategories,
  useCategoryFields,
  useCreateCategory,
  useDeleteCategory,
  useDeleteCategoryField,
  useUpdateCategory,
} from '../categories';
import {
  applyCategoryStarterSeed,
  hasCategoryNamed,
  TOOLS_STARTER_CATEGORY_NAME,
  TOOLS_STARTER_SEED,
} from '../tools-starter-seed';
import {
  ATTACHMENT_MODE_LABELS,
  conditionSelectOptions,
  FIELD_TYPE_LABELS,
  MAINTENANCE_BASIS_LABELS,
  TRACKING_MODE_LABELS,
} from './inventory-ui';
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
        <ToolsStarterButton existingNames={rows.map((c) => c.name)} onSeeded={(id) => setSelectedId(id)} />
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

/**
 * One-tap "Add a Tools category" affordance (backlog T4). A convenience/discoverability
 * shortcut that materialises the {@link TOOLS_STARTER_SEED} — a category pre-wired with
 * the T1/T2 facet defaults and a couple of tool-ish custom fields — through the ordinary
 * create-category / add-field mutation path (no bespoke repository method).
 *
 * Idempotent by construction: it hides itself once a category named "Tools" exists, so a
 * second tap can never create a duplicate.
 */
function ToolsStarterButton({
  existingNames,
  onSeeded,
}: {
  existingNames: readonly string[];
  onSeeded: (categoryId: string) => void;
}) {
  const createCategory = useCreateCategory();
  const addField = useAddCategoryField();

  if (hasCategoryNamed(existingNames, TOOLS_STARTER_CATEGORY_NAME)) return null;

  const pending = createCategory.isPending || addField.isPending;

  const seed = () =>
    void applyCategoryStarterSeed(TOOLS_STARTER_SEED, {
      createCategory: (input) => createCategory.mutateAsync(input),
      addField: (categoryId, input) => addField.mutateAsync({ categoryId, input }),
    }).then(onSeeded);

  return (
    <Tooltip
      content="Create a ready-made **Tools** category — serialised tracking, a 12-month warranty window, and *Serial number* & *Calibration certificate* fields — that you can tweak afterwards."
      triggerTabIndex={-1}
    >
      <span className="block">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={seed} disabled={pending}>
          <ToolsIcon />
          Add a Tools category
        </Button>
      </span>
    </Tooltip>
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

      <CategoryDefaultsSection category={category} />
    </div>
  );
}

/**
 * Seed interval offered the moment a maintenance basis is first chosen (backlog T2a), so a
 * freshly-picked basis is immediately effective rather than a silent no-op — the user can still
 * edit or clear it. A year for TIME (matching the "annual calibration" archetype); 100 units for
 * USAGE (mirrors the MaintenanceEditor's own default).
 */
const MAINTENANCE_INTERVAL_SEED: Record<MaintenanceBasis, number> = { TIME: 365, USAGE: 100 };

/**
 * "Defaults for new items in this category" — the editor for the category-template defaults:
 * the T1/T2 soft-prefills (tracking mode, condition, warranty window) plus the T2a default
 * *maintenance schedule*. These are plain LWW columns with no draft/confirm model, so each
 * control **auto-saves immediately** via `useUpdateCategory` (mirroring the Settings dialog's
 * per-row auto-save), clearing to `null`. This is a direct read-from-category / write-back
 * editor — the T1/T2 *soft-prefill* logic lives on the create form, and the T2a schedule is
 * *applied* by the item create paths, not here.
 */
function CategoryDefaultsSection({ category }: { category: CategoryWithFieldCount }) {
  const updateCategory = useUpdateCategory();
  const save = (input: {
    defaultTrackingMode?: TrackingMode | null;
    defaultCondition?: Condition | null;
    defaultWarrantyMonths?: number | null;
    defaultMaintenanceBasis?: MaintenanceBasis | null;
    defaultMaintenanceIntervalDays?: number | null;
    defaultMaintenanceIntervalUsage?: number | null;
  }) => updateCategory.mutate({ id: category.id, input });

  // The warranty field is a free-text number, so it keeps a local buffer (reset when the
  // selected category changes) rather than being driven straight from the persisted value —
  // that keeps mid-edit keystrokes from being clobbered by the write-back refresh.
  const [warrantyText, setWarrantyText] = useState(
    category.defaultWarrantyMonths != null ? String(category.defaultWarrantyMonths) : '',
  );
  useEffect(() => {
    setWarrantyText(category.defaultWarrantyMonths != null ? String(category.defaultWarrantyMonths) : '');
  }, [category.id, category.defaultWarrantyMonths]);

  const commitWarranty = (raw: string) => {
    setWarrantyText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      save({ defaultWarrantyMonths: null });
      return;
    }
    const months = Number.parseInt(trimmed, 10);
    // Only persist a valid whole-month window (>= 1); an in-progress/invalid entry is held
    // in the buffer until it parses, never written as junk.
    if (Number.isInteger(months) && months >= 1) {
      save({ defaultWarrantyMonths: months });
    }
  };

  // Default maintenance schedule (backlog T2a). Like the warranty field, the interval keeps a
  // local buffer so mid-edit keystrokes aren't clobbered by the write-back refresh; it is seeded
  // from whichever interval column matches the persisted basis.
  const maintBasis = category.defaultMaintenanceBasis;
  const persistedInterval =
    maintBasis === 'TIME'
      ? category.defaultMaintenanceIntervalDays
      : maintBasis === 'USAGE'
        ? category.defaultMaintenanceIntervalUsage
        : null;
  const [maintIntervalText, setMaintIntervalText] = useState(
    persistedInterval != null ? String(persistedInterval) : '',
  );
  useEffect(() => {
    setMaintIntervalText(persistedInterval != null ? String(persistedInterval) : '');
  }, [category.id, persistedInterval]);

  // Persist the {basis, matching-interval} pair coherently: only the interval column for the
  // chosen basis is set, the other is nulled. A blank/invalid interval stores null — a
  // half-configured default the item create paths treat as a no-op — so nothing junk is written.
  const saveMaintenance = (basis: MaintenanceBasis, text: string) => {
    const n = Number.parseInt(text.trim(), 10);
    const val = text.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
    save({
      defaultMaintenanceBasis: basis,
      defaultMaintenanceIntervalDays: basis === 'TIME' ? val : null,
      defaultMaintenanceIntervalUsage: basis === 'USAGE' ? val : null,
    });
  };

  const changeBasis = (value: string) => {
    if (value === '') {
      setMaintIntervalText('');
      save({
        defaultMaintenanceBasis: null,
        defaultMaintenanceIntervalDays: null,
        defaultMaintenanceIntervalUsage: null,
      });
      return;
    }
    const basis = value as MaintenanceBasis;
    // Seed a friendly interval when the field is empty, so a just-chosen basis is effective
    // straight away (never a silent no-op); keep any number the user already typed.
    const seeded = maintIntervalText.trim() || String(MAINTENANCE_INTERVAL_SEED[basis]);
    setMaintIntervalText(seeded);
    saveMaintenance(basis, seeded);
  };

  const commitInterval = (raw: string) => {
    setMaintIntervalText(raw);
    if (maintBasis == null) return; // no basis chosen yet — nothing to attach the interval to
    saveMaintenance(maintBasis, raw);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/10 p-2.5">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        Defaults for new items in this category
        <InfoHint content="Pre-fill the create-item form for this category. Each is a **starting point** you can still change per item — changing them here never touches existing items." />
      </h4>

      <SelectField
        label="Tracking mode"
        hint="How a new item in this category is tracked by default — e.g. **Serialised** for tools you track one-by-one. Choose *— No default —* to leave it unset."
        value={category.defaultTrackingMode ?? ''}
        onChange={(value) => save({ defaultTrackingMode: value === '' ? null : (value as TrackingMode) })}
        options={[
          { value: '', label: '— No default —' },
          ...TRACKING_MODES.map((mode) => ({ value: mode, label: TRACKING_MODE_LABELS[mode] })),
        ]}
      />

      <SelectField
        label="Condition"
        hint="The condition a new item in this category starts in — e.g. **Good**. Choose *— No default —* to leave it unset."
        value={category.defaultCondition ?? ''}
        onChange={(value) => save({ defaultCondition: value === '' ? null : (value as Condition) })}
        options={conditionSelectOptions('— No default —')}
      />

      <FormField
        label="Warranty (months)"
        hint={
          'A default warranty **window in whole months** (not a date). On create it is turned ' +
          'into an expiry date measured from the item’s *Acquired date* (or today) — so *12* ' +
          'here means a new item is under warranty for a year. Leave blank for no default.'
        }
      >
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="e.g. 12"
          aria-label="Default warranty in months"
          value={warrantyText}
          onChange={(e) => commitWarranty(e.target.value)}
        />
      </FormField>

      <SelectField
        label="Maintenance schedule"
        hint={
          'Give new items in this category a **recurring service schedule** automatically — e.g. an ' +
          'annual calibration. Unlike the fields above (which only pre-fill the create form), this ' +
          'schedule is **created on the item** the moment it is added.\n\n' +
          '- **Time-based** — due every N **days**.\n' +
          '- **Usage-based** — due every N units of use.\n\n' +
          'Choose *— No default —* for none. You can rename or tweak each schedule on the item later.'
        }
        value={maintBasis ?? ''}
        onChange={changeBasis}
        options={[
          { value: '', label: '— No default —' },
          ...MAINTENANCE_BASES.map((b) => ({ value: b, label: MAINTENANCE_BASIS_LABELS[b] })),
        ]}
      />

      {maintBasis != null ? (
        <FormField
          label={maintBasis === 'TIME' ? 'Every (days)' : 'Every (uses)'}
          hint={
            maintBasis === 'TIME'
              ? 'How often the service falls due, in **whole days** — e.g. *365* for a yearly ' +
                'calibration. Clear it to leave the schedule off.'
              : 'How many **units of use** between services — e.g. *100* running hours. Clear it to ' +
                'leave the schedule off.'
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={maintBasis === 'TIME' ? 'e.g. 365' : 'e.g. 100'}
            aria-label={
              maintBasis === 'TIME'
                ? 'Default maintenance interval in days'
                : 'Default maintenance usage interval'
            }
            value={maintIntervalText}
            onChange={(e) => commitInterval(e.target.value)}
          />
        </FormField>
      ) : null}
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
