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
  useSearchEscapeToClear,
} from '@/components/foundry';
import { SearchIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import { toGrams } from '@/lib/weight';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCreateTarePreset, useTarePresets } from '../tare-preset-queries';
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

  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TarePresetKind>('OTHER');
  const [weight, setWeight] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useSearchEscapeToClear(open, searchRef, () => setQuery(''));

  const matches = useMemo(() => searchTarePresets(presets, query), [presets, query]);
  const groups = useMemo(() => groupTarePresetsByKind(matches), [matches]);

  const weightValue = Number(weight.trim());
  const weightValid = weight.trim() !== '' && Number.isFinite(weightValue) && weightValue >= 0;
  const nameValid = name.trim() !== '';

  /** Open the save form, pre-filled from the field's current value where there is one. */
  const startSaving = () => {
    const prefill =
      currentTareGrams != null && Number.isFinite(currentTareGrams) && currentTareGrams >= 0
        ? tareFieldValue(currentTareGrams, weightUnit)
        : '';
    setWeight(prefill);
    setName('');
    setKind('OTHER');
    setSaving(true);
  };

  const save = () => {
    if (!nameValid || !weightValid || createPreset.isPending) return;
    createPreset.mutate(
      { name: name.trim(), kind, tareGrams: toGrams(weightValue, weightUnit) },
      {
        onSuccess: (preset) => {
          setSaving(false);
          // Saving a container is only ever done in order to *use* it, so applying it closes
          // the loop rather than leaving the user to find their new entry in the list.
          onSelect(preset.tareGrams);
          onClose();
        },
      },
    );
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
                      onSelect={() => {
                        onSelect(preset.tareGrams);
                        onClose();
                      }}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {saving ? (
          <div className="space-y-3 rounded-md border border-border bg-card p-3">
            <h3 className="text-sm font-medium">{t('inventory.tarePresets.save.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('inventory.tarePresets.save.help')}</p>
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
            {createPreset.isError ? (
              <p role="alert" className="text-xs text-destructive" data-testid="tare-preset-error">
                {t('inventory.tarePresets.save.failed')}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSaving(false)}>
                {t('inventory.tarePresets.save.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={save}
                disabled={!nameValid || !weightValid || createPreset.isPending}
                data-testid="tare-preset-save"
              >
                {t('inventory.tarePresets.save.confirm')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={startSaving} data-testid="tare-preset-add">
            {t('inventory.tarePresets.save.open')}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** One selectable container: its name, what it weighs, and what was measured. */
function TarePresetRow({
  preset,
  formatted,
  savedLabel,
  onSelect,
}: {
  preset: TarePreset;
  formatted: string;
  savedLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-3 py-2 text-left transition-colors ease-emphasized hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
  );
}
