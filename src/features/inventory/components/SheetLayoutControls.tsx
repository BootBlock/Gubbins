import { useEffect, useId, useState } from 'react';
import { Checkbox, InfoHint, Input, Select } from '@/components/foundry';
import { useT, type TypedTranslator } from '@/features/i18n';
import {
  LABEL_COLUMNS_BOUNDS,
  LABEL_ROWS_BOUNDS,
  SHEET_GAP_BOUNDS,
  SHEET_LAYOUT_CUSTOM_ID,
  SHEET_MARGIN_BOUNDS,
  SHEET_STOCK_PRESETS,
  clampColumns,
  clampMm,
  clampRows,
  formatSheetCellSize,
  normaliseSheetLayout,
  sheetLabelCount,
  sheetLayoutSelection,
  type SheetStockPreset,
  type SheetLayout,
} from '../labels/label-template';

/** `21 per sheet — 63.5 × 38.1 mm` — how a stock preset reads in the picker. */
function presetLabel(preset: SheetStockPreset, t: TypedTranslator): string {
  return t('inventory.labels.sheetPerSheet', {
    vars: { count: sheetLabelCount(preset.layout), size: formatSheetCellSize(preset.layout) },
  });
}

/**
 * What each option is marked with, beside its size: the trade codes a packet of stock
 * carries, or — for the layout that is not a product — that it is plain paper, so the
 * default entry is not left looking like an unnamed sheet of stickers.
 */
function presetMeta(preset: SheetStockPreset, t: TypedTranslator): string {
  return preset.code || t('inventory.labels.sheetPlainPaper');
}

/** Rich-Markdown help for the sheet-layout control (a {@link SHEET_STOCK_PRESETS} rundown). */
function layoutHint(t: TypedTranslator): string {
  return [
    t('inventory.labels.sheetLayoutHintIntro'),
    '',
    ...SHEET_STOCK_PRESETS.map(
      (p) =>
        `- **${presetLabel(p, t)}** (${presetMeta(p, t)}) — ${t(`inventory.labels.sheetStockUse.${p.id}`)}`,
    ),
    '',
    t('inventory.labels.sheetLayoutHintCustom'),
  ].join('\n');
}

/**
 * The A4 **sheet layout** picker shared by the item and location print dialogs: a
 * combobox of common sticker-sheet stock (plus plain paper and a "Custom…" escape
 * hatch), the size one label works out to, and — for a custom layout — the columns,
 * rows, page margins and gutters that produce it.
 *
 * This is what lets a named sheet of labels be targeted at all: the printed grid is
 * tiled to exactly these numbers, so each label lands on a sticker rather than across
 * the gap between two (issue #333). Driven entirely by the layout via
 * {@link sheetLayoutSelection}, so there is no separate "which preset" state to sync.
 */
export function SheetLayoutControls({
  value,
  onChange,
  testId = 'sheet-layout',
}: {
  readonly value: SheetLayout;
  readonly onChange: (value: SheetLayout) => void;
  readonly testId?: string;
}) {
  const t = useT();
  const labelId = useId();
  const layout = normaliseSheetLayout(value);
  const derived = sheetLayoutSelection(layout);
  // "Custom…" is a user intent, not just a shape: a hand-entered layout may happen to
  // equal a preset (so `derived` would snap to it), yet the user asked to type their own.
  const [customIntent, setCustomIntent] = useState(false);
  const selection = customIntent || derived === SHEET_LAYOUT_CUSTOM_ID ? SHEET_LAYOUT_CUSTOM_ID : derived;

  const handleSelect = (id: string) => {
    if (id === SHEET_LAYOUT_CUSTOM_ID) {
      setCustomIntent(true);
      return;
    }
    const preset = SHEET_STOCK_PRESETS.find((p) => p.id === id);
    if (preset) {
      setCustomIntent(false);
      onChange(preset.layout);
    }
  };

  const set = <K extends keyof SheetLayout>(key: K, next: SheetLayout[K]) =>
    onChange({ ...layout, [key]: next });

  /** Commit one numeric field, reporting back the value actually stored (see {@link MmField}). */
  const commit = (key: Exclude<keyof SheetLayout, 'outline'>, next: number): number => {
    set(key, next);
    return next;
  };

  return (
    <div className="flex flex-col gap-field-gap-compact text-xs font-medium text-muted-foreground sm:col-span-2">
      <span className="flex items-center gap-1">
        <span id={labelId}>{t('inventory.labels.sheetLayout')}</span>
        <InfoHint content={layoutHint(t)} />
      </span>
      <Select
        aria-labelledby={labelId}
        value={selection}
        onChange={handleSelect}
        data-testid={testId}
        options={[
          ...SHEET_STOCK_PRESETS.map((p) => ({
            value: p.id,
            label: presetLabel(p, t),
            meta: presetMeta(p, t),
          })),
          { value: SHEET_LAYOUT_CUSTOM_ID, label: t('inventory.labels.sheetCustom') },
        ]}
      />

      {selection === SHEET_LAYOUT_CUSTOM_ID ? (
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <MmField
            label={t('inventory.labels.sheetColumns')}
            value={layout.columns}
            step={1}
            bounds={LABEL_COLUMNS_BOUNDS}
            testId={`${testId}-columns`}
            onCommit={(raw) => commit('columns', clampColumns(raw))}
          />
          <MmField
            label={t('inventory.labels.sheetRows')}
            value={layout.rows}
            step={1}
            bounds={LABEL_ROWS_BOUNDS}
            testId={`${testId}-rows`}
            onCommit={(raw) => commit('rows', clampRows(raw))}
          />
          <MmField
            label={t('inventory.labels.sheetMarginTop')}
            value={layout.marginTopMm}
            bounds={SHEET_MARGIN_BOUNDS}
            testId={`${testId}-margin-top`}
            onCommit={(raw) => commit('marginTopMm', clampMm(raw, SHEET_MARGIN_BOUNDS, layout.marginTopMm))}
          />
          <MmField
            label={t('inventory.labels.sheetMarginSide')}
            value={layout.marginSideMm}
            bounds={SHEET_MARGIN_BOUNDS}
            testId={`${testId}-margin-side`}
            onCommit={(raw) => commit('marginSideMm', clampMm(raw, SHEET_MARGIN_BOUNDS, layout.marginSideMm))}
          />
          <MmField
            label={t('inventory.labels.sheetColumnGap')}
            value={layout.columnGapMm}
            bounds={SHEET_GAP_BOUNDS}
            testId={`${testId}-column-gap`}
            onCommit={(raw) => commit('columnGapMm', clampMm(raw, SHEET_GAP_BOUNDS, layout.columnGapMm))}
          />
          <MmField
            label={t('inventory.labels.sheetRowGap')}
            value={layout.rowGapMm}
            bounds={SHEET_GAP_BOUNDS}
            testId={`${testId}-row-gap`}
            onCommit={(raw) => commit('rowGapMm', clampMm(raw, SHEET_GAP_BOUNDS, layout.rowGapMm))}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {/* The one number that says whether the sheet in the printer is the sheet on
            screen — a preset is only trustworthy if its label size matches the packet. */}
        <span data-testid={`${testId}-cell-size`}>
          {t('inventory.labels.sheetEachLabel', { vars: { size: formatSheetCellSize(layout) } })}
        </span>
        <span className="flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={layout.outline}
              onChange={(e) => set('outline', e.target.checked)}
              data-testid={`${testId}-outline`}
            />
            {t('inventory.labels.sheetOutline')}
          </label>
          <InfoHint content={t('inventory.labels.sheetOutlineHint')} />
        </span>
      </div>
    </div>
  );
}

/**
 * One small numeric field of the custom layout. Keeps the raw keystrokes in local state
 * so a partial value (mid-typing "1" before "15") is not clamped away, and commits a
 * clamped value on blur — the same contract as the die-cut size inputs.
 *
 * `onCommit` hands back the value it actually committed, and the field echoes *that*.
 * Syncing on the prop alone is not enough: an out-of-range entry whose clamp lands back
 * on the value already held changes nothing to react to, so the rejected keystrokes would
 * sit on screen indefinitely, disagreeing with the layout in use.
 */
function MmField({
  label,
  value,
  bounds,
  step = 0.1,
  onCommit,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly step?: number;
  readonly onCommit: (raw: string) => number;
  readonly testId: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  return (
    <label htmlFor={id} className="flex flex-col gap-field-gap-compact">
      <span>{label}</span>
      <Input
        id={id}
        type="number"
        inputMode={step === 1 ? 'numeric' : 'decimal'}
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={text}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setText(String(onCommit(text)))}
        className="h-9"
      />
    </label>
  );
}
