import { useEffect, useId, useState } from 'react';
import { InfoHint, Input, Select } from '@/components/foundry';
import {
  LABEL_SIZE_BOUNDS,
  LABEL_SIZE_CUSTOM_ID,
  LABEL_SIZE_HINT,
  LABEL_SIZE_PRESETS,
  LABEL_SIZE_SHEET_ID,
  clampLabelDimension,
  labelSizeSelection,
  type LabelSizeMode,
} from '../labels/label-template';

/** The size fields of a {@link LabelTemplate} this control edits. */
export interface LabelSizeValue {
  readonly sizeMode: LabelSizeMode;
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Preset + "A4 sheet" + "Custom…" options for the size combobox, in display order. */
const SIZE_OPTIONS = [
  { value: LABEL_SIZE_SHEET_ID, label: 'A4 sheet (grid)' },
  ...LABEL_SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
  { value: LABEL_SIZE_CUSTOM_ID, label: 'Custom…' },
];

/**
 * The label-size picker shared by the item and location print dialogs: a combobox of
 * common thermal / die-cut sizes (plus the A4 grid and a "Custom…" escape hatch) with
 * an {@link InfoHint} explaining what each preset suits, and width/height mm inputs
 * revealed for a bespoke size. Driven entirely by the template's size fields via
 * {@link labelSizeSelection}, so there is no separate "which preset" state to sync.
 */
export function LabelSizeControls({
  value,
  onChange,
  testId = 'label-size',
}: {
  readonly value: LabelSizeValue;
  readonly onChange: (value: LabelSizeValue) => void;
  readonly testId?: string;
}) {
  const labelId = useId();
  const derived = labelSizeSelection({
    sizeMode: value.sizeMode,
    labelWidthMm: value.widthMm,
    labelHeightMm: value.heightMm,
  });
  // "Custom…" is a user intent, not just a shape: the current dimensions may happen to
  // equal a preset (so `derived` would snap to it), yet the user asked to type their own.
  // Track that intent locally and clear it whenever the size resolves back to the sheet.
  const [customIntent, setCustomIntent] = useState(false);
  useEffect(() => {
    if (value.sizeMode === 'sheet') setCustomIntent(false);
  }, [value.sizeMode]);
  const selection = customIntent || derived === LABEL_SIZE_CUSTOM_ID ? LABEL_SIZE_CUSTOM_ID : derived;

  const handleSelect = (id: string) => {
    if (id === LABEL_SIZE_SHEET_ID) {
      setCustomIntent(false);
      onChange({ ...value, sizeMode: 'sheet' });
      return;
    }
    if (id === LABEL_SIZE_CUSTOM_ID) {
      setCustomIntent(true);
      onChange({ ...value, sizeMode: 'die-cut' });
      return;
    }
    const preset = LABEL_SIZE_PRESETS.find((p) => p.id === id);
    if (preset) {
      setCustomIntent(false);
      onChange({ sizeMode: 'die-cut', widthMm: preset.widthMm, heightMm: preset.heightMm });
    }
  };

  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground sm:col-span-2">
      <span className="flex items-center gap-1">
        <span id={labelId}>Label size</span>
        <InfoHint content={LABEL_SIZE_HINT} />
      </span>
      <Select
        aria-labelledby={labelId}
        value={selection}
        onChange={handleSelect}
        data-testid={testId}
        options={SIZE_OPTIONS}
      />

      {selection === LABEL_SIZE_CUSTOM_ID ? (
        <div className="mt-1 flex items-end gap-2">
          <DimField
            label="Width (mm)"
            value={value.widthMm}
            testId={`${testId}-width`}
            onChange={(mm) => onChange({ ...value, sizeMode: 'die-cut', widthMm: mm })}
          />
          <span className="pb-2.5 text-muted-foreground" aria-hidden>
            ×
          </span>
          <DimField
            label="Height (mm)"
            value={value.heightMm}
            testId={`${testId}-height`}
            onChange={(mm) => onChange({ ...value, sizeMode: 'die-cut', heightMm: mm })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One millimetre dimension input. Keeps the raw keystrokes in local state so a partial
 * value (e.g. mid-typing "4" before "40") is not clamped away; commits a rounded, bounds-
 * clamped value on blur, falling back to the previous value for unparseable input.
 */
function DimField({
  label,
  value,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (mm: number) => void;
  readonly testId: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const mm = clampLabelDimension(text, value);
    onChange(mm);
    setText(String(mm));
  };

  return (
    <label htmlFor={id} className="flex flex-1 flex-col gap-1">
      <span>{label}</span>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={LABEL_SIZE_BOUNDS.min}
        max={LABEL_SIZE_BOUNDS.max}
        value={text}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        className="h-9"
      />
    </label>
  );
}
