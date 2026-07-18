import { useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  FormField,
  Input,
  InputClearButton,
  LiveRegion,
  Modal,
  SelectField,
  Spinner,
  useSearchEscapeToClear,
} from '@/components/foundry';
import { DeleteIcon, EditIcon, SearchIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import { toGrams } from '@/lib/weight';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  useCreateTarePreset,
  useDeleteTarePreset,
  useTarePresets,
  useUpdateTarePreset,
} from '../tare-preset-queries';
import {
  groupTarePresetsByKind,
  searchTarePresets,
  tarePresetLabel,
  tareFieldValue,
  TARE_PRESET_KINDS,
  type TarePreset,
  type TarePresetKind,
} from '../tare-presets';

/** The translated heading for each container kind (typed, so a new kind can't miss one). */
const KIND_LABEL_KEY: Record<TarePresetKind, MessageKey> = {
  SPOOL: 'inventory.tarePresets.kind.spool',
  JAR: 'inventory.tarePresets.kind.jar',
  BIN: 'inventory.tarePresets.kind.bin',
  TRAY: 'inventory.tarePresets.kind.tray',
  OTHER: 'inventory.tarePresets.kind.other',
};

/**
 * Container-weight picker (issue #94) — fills a tare field from a saved or built-in
 * container instead of the user retyping the number from memory.
 *
 * Two things keep this honest rather than merely convenient, and they are why the dialog is
 * shaped the way it is:
 *
 * - **A published spool weight is a starting point, not a fact about the spool in your hand.**
 *   Manufacturers change spool designs without renaming the product, so the built-in figures
 *   carry a standing "check this on your scale" caveat rather than being presented as exact.
 *   Each entry also shows what was actually measured, so a user can judge how much to trust it.
 * - **A container you weighed yourself is always right.** Saving your own is therefore a
 *   first-class action here, not an afterthought — and saved containers sort *above* the
 *   built-in catalogue, because your own measurement beats any published figure.
 *
 * Weights are stored and passed out in canonical **grams**; the user reads and types them in
 * their `weightUnit` preference, converted at this edge exactly as the weigh-count dialog does.
 */
export function TarePresetPicker({
  open,
  onClose,
  onSelect,
  currentTareGrams,
}: {
  open: boolean;
  onClose: () => void;
  /** Receives the chosen container's tare in canonical grams. */
  onSelect: (tareGrams: number) => void;
  /**
   * The tare currently in the field being filled, in grams, when it holds a usable value.
   * Pre-fills the "save this container" form so the common case — "I just weighed this, keep
   * it" — is one field and a button rather than re-entering the number.
   */
  currentTareGrams?: number | null;
}) {
  const t = useT();
  const fmt = useFormatters();
  const weightUnit = usePreferencesStore((s) => s.weightUnit);
  const { presets } = useTarePresets();
  const createPreset = useCreateTarePreset();
  const updatePreset = useUpdateTarePreset();
  const deletePreset = useDeleteTarePreset();

  const [query, setQuery] = useState('');
  /**
   * The open form, if any: `{ editingId: null }` is "save a new container", while an id is
   * "edit that saved one". One piece of state rather than two booleans, so the two modes
   * cannot both be open at once and the shared fields below always describe exactly one of them.
   *
   * `pristineWeight` remembers what an edit was opened with. The field shows the weight
   * rounded into the display unit, so writing it back unconditionally would let "rename this
   * container" quietly re-round the measurement the user took. Leaving the field untouched
   * therefore restores the stored grams verbatim instead.
   */
  const [form, setForm] = useState<{
    editingId: string | null;
    pristineWeight: { field: string; grams: number } | null;
  } | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TarePresetKind>('OTHER');
  const [weight, setWeight] = useState('');
  /** The saved container awaiting delete confirmation; null when nothing is pending. */
  const [confirmDelete, setConfirmDelete] = useState<TarePreset | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useSearchEscapeToClear(open, searchRef, () => setQuery(''));

  const matches = useMemo(() => searchTarePresets(presets, query), [presets, query]);
  const groups = useMemo(() => groupTarePresetsByKind(matches), [matches]);

  const weightValue = Number(weight.trim());
  const weightValid = weight.trim() !== '' && Number.isFinite(weightValue) && weightValue >= 0;
  const nameValid = name.trim() !== '';

  // A delete in flight counts too: the row being removed may be the one the form is editing,
  // and the form must not submit an update against it in the window before the delete lands.
  const isPending = createPreset.isPending || updatePreset.isPending || deletePreset.isPending;

  /** Open the save form, pre-filled from the field's current value where there is one. */
  const startSaving = () => {
    const prefill =
      currentTareGrams != null && Number.isFinite(currentTareGrams) && currentTareGrams >= 0
        ? tareFieldValue(currentTareGrams, weightUnit)
        : '';
    setWeight(prefill);
    setName('');
    setKind('OTHER');
    createPreset.reset();
    updatePreset.reset();
    setForm({ editingId: null, pristineWeight: null });
  };

  /** Open the same form over an existing saved container, pre-filled with what it holds. */
  const startEditing = (preset: TarePreset) => {
    const field = tareFieldValue(preset.tareGrams, weightUnit);
    setName(preset.name);
    setKind(preset.kind);
    setWeight(field);
    createPreset.reset();
    updatePreset.reset();
    setForm({ editingId: preset.id, pristineWeight: { field, grams: preset.tareGrams } });
  };

  const save = () => {
    if (!form || !nameValid || !weightValid || isPending) return;
    // An untouched weight field keeps the stored grams exactly, so correcting a name can never
    // shift the measurement by the rounding the field displays it with.
    const tareGrams =
      form.pristineWeight !== null && weight.trim() === form.pristineWeight.field
        ? form.pristineWeight.grams
        : toGrams(weightValue, weightUnit);
    const fields = { name: name.trim(), kind, tareGrams };

    if (form.editingId !== null) {
      updatePreset.mutate(
        { id: form.editingId, input: fields },
        {
          // An edit corrects the library, which is not the same as choosing a container — so it
          // closes the form and leaves the user in the list, rather than filling the field and
          // dismissing the picker the way saving a *new* container does.
          onSuccess: () => setForm(null),
        },
      );
      return;
    }

    createPreset.mutate(fields, {
      onSuccess: (preset) => {
        setForm(null);
        // Saving a container is only ever done in order to *use* it, so applying it closes
        // the loop rather than leaving the user to find their new entry in the list.
        onSelect(preset.tareGrams);
        onClose();
      },
    });
  };

  /** Ask before removing: a saved container is a measurement the user cannot get back. */
  const requestDelete = (preset: TarePreset) => {
    deletePreset.reset();
    setConfirmDelete(preset);
  };

  const confirmDeleteNow = () => {
    if (!confirmDelete || deletePreset.isPending) return;
    const { id } = confirmDelete;
    deletePreset.mutate(id, {
      onSuccess: () => {
        setConfirmDelete(null);
        // Editing the entry that just went away would leave the form writing to nothing.
        setForm((current) => (current?.editingId === id ? null : current));
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.tarePresets.title')}
      description={t('inventory.tarePresets.description')}
      scrollBody
    >
      <div className="space-y-3">
        <Banner tone="info">{t('inventory.tarePresets.caveat')}</Banner>

        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('inventory.tarePresets.search.label')}
            placeholder={t('inventory.tarePresets.search.placeholder')}
            className="pl-9 pr-9"
            data-testid="tare-preset-search"
          />
          {query !== '' ? (
            <InputClearButton
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
              label={t('inventory.tarePresets.search.clear')}
            />
          ) : null}
        </div>

        <LiveRegion className="empty:hidden">
          {query !== '' ? (
            <p className="text-xs text-muted-foreground">
              {matches.length === 0
                ? t('inventory.tarePresets.results.none', { vars: { query } })
                : t(
                    matches.length === 1
                      ? 'inventory.tarePresets.results.one'
                      : 'inventory.tarePresets.results.other',
                    { vars: { count: matches.length } },
                  )}
            </p>
          ) : null}
        </LiveRegion>

        <ul className="space-y-4">
          {groups.map((group) => (
            <li key={group.kind}>
              <h3 className="mb-field-gap-compact text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(KIND_LABEL_KEY[group.kind])}
              </h3>
              <ul className="space-y-1">
                {group.presets.map((preset) => (
                  <li key={preset.id}>
                    <TarePresetRow
                      preset={preset}
                      formatted={fmt.weight(preset.tareGrams)}
                      savedLabel={t('inventory.tarePresets.savedBadge')}
                      editLabel={t('inventory.tarePresets.edit.label', {
                        vars: { name: tarePresetLabel(preset) },
                      })}
                      deleteLabel={t('inventory.tarePresets.delete.label', {
                        vars: { name: tarePresetLabel(preset) },
                      })}
                      onSelect={() => {
                        onSelect(preset.tareGrams);
                        onClose();
                      }}
                      onEdit={() => startEditing(preset)}
                      onDelete={() => requestDelete(preset)}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {form ? (
          <div className="space-y-3 rounded-md border border-border bg-card p-3">
            <h3 className="text-sm font-medium">
              {t(
                form.editingId !== null
                  ? 'inventory.tarePresets.edit.title'
                  : 'inventory.tarePresets.save.title',
              )}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                form.editingId !== null
                  ? 'inventory.tarePresets.edit.help'
                  : 'inventory.tarePresets.save.help',
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('inventory.tarePresets.save.name')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('inventory.tarePresets.save.namePlaceholder')}
                  data-testid="tare-preset-name"
                />
              </FormField>
              {/* SelectField, not FormField + Select: a `role="combobox"` is not a labelable
                  form control, so FormField's implicit <label> would leave it unnamed for a
                  screen reader. SelectField wires the `aria-labelledby` idiom instead. */}
              <SelectField
                label={t('inventory.tarePresets.save.kind')}
                value={kind}
                onChange={(value) => setKind(value as TarePresetKind)}
                options={TARE_PRESET_KINDS.map((value) => ({
                  value,
                  label: t(KIND_LABEL_KEY[value]),
                }))}
              />
              <FormField
                label={t('inventory.tarePresets.save.weight', { vars: { unit: weightUnit } })}
                error={
                  weight.trim() === '' || weightValid
                    ? undefined
                    : t('inventory.tarePresets.save.weightError')
                }
              >
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  data-testid="tare-preset-weight"
                />
              </FormField>
            </div>
            {/* A save can genuinely fail — the repository refuses growth-writes while storage
                is locked — and silently doing nothing when the button is pressed is the worst
                outcome, so the reason is surfaced rather than swallowed. */}
            {createPreset.isError || updatePreset.isError ? (
              <p role="alert" className="text-xs text-destructive" data-testid="tare-preset-error">
                {t(
                  updatePreset.isError
                    ? 'inventory.tarePresets.edit.failed'
                    : 'inventory.tarePresets.save.failed',
                )}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setForm(null)} disabled={isPending}>
                {t('inventory.tarePresets.save.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={save}
                disabled={!nameValid || !weightValid || isPending}
                data-testid="tare-preset-save"
              >
                {t(
                  form.editingId !== null
                    ? 'inventory.tarePresets.edit.confirm'
                    : 'inventory.tarePresets.save.confirm',
                )}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={startSaving} data-testid="tare-preset-add">
            {t('inventory.tarePresets.save.open')}
          </Button>
        )}
      </div>

      {/* Removing a measurement the user took themselves is not undoable, so it is confirmed
          in its own dialog rather than deleting straight from the row. */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t('inventory.tarePresets.delete.title')}
        description={
          confirmDelete
            ? t('inventory.tarePresets.delete.description', {
                vars: { name: tarePresetLabel(confirmDelete) },
              })
            : undefined
        }
      >
        {deletePreset.isError ? (
          <p role="alert" className="mb-3 text-xs text-destructive" data-testid="tare-preset-delete-error">
            {t('inventory.tarePresets.delete.failed')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deletePreset.isPending}>
            {t('inventory.tarePresets.delete.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={confirmDeleteNow}
            disabled={deletePreset.isPending}
            data-testid="confirm-delete-tare-preset"
          >
            {deletePreset.isPending ? <Spinner /> : <DeleteIcon aria-hidden="true" />}
            {t('inventory.tarePresets.delete.confirm')}
          </Button>
        </div>
      </Modal>
    </Modal>
  );
}

/**
 * One selectable container: its name, what it weighs, and what was measured.
 *
 * A container the user saved also carries edit and delete controls. They sit *beside* the
 * select button rather than inside it — a button cannot legally nest another — and only on
 * saved entries, since the built-in catalogue is not the user's to change.
 */
function TarePresetRow({
  preset,
  formatted,
  savedLabel,
  editLabel,
  deleteLabel,
  onSelect,
  onEdit,
  onDelete,
}: {
  preset: TarePreset;
  formatted: string;
  savedLabel: string;
  editLabel: string;
  deleteLabel: string;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-3 py-2 text-left transition-colors ease-emphasized hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{tarePresetLabel(preset)}</span>
            {preset.saved ? (
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                {savedLabel}
              </span>
            ) : null}
          </span>
          {preset.note ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{preset.note}</span>
          ) : null}
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums">{formatted}</span>
      </button>
      {preset.saved ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={editLabel}
            onClick={onEdit}
            data-testid={`tare-preset-edit-${preset.id}`}
          >
            <EditIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={deleteLabel}
            onClick={onDelete}
            data-testid={`tare-preset-delete-${preset.id}`}
          >
            <DeleteIcon aria-hidden="true" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
