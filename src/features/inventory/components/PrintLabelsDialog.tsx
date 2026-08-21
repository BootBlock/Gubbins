import { useEffect, useId, useMemo, useState } from 'react';
import { plural } from '@/lib/plural';
import { Banner, Button, Checkbox, InfoHint, Modal, Select, type SelectProps } from '@/components/foundry';
import { PrintIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { resolveLabelBaseUrl } from '@/features/scanner/scan-payload';
import { useT } from '@/features/i18n';
import {
  LABEL_SYMBOLOGY_OPTIONS,
  normaliseLabelTemplate,
  sheetCellSizeMm,
  templateHasBarcode,
  templateHasQr,
  type LabelSymbology,
  type LabelTemplate,
} from '../labels/label-template';
import { MAX_LABELS, buildLabelSheetHtml, toLabelCells, type LabelItem } from '../labels/label-sheet';
import { DieCutPrinterNotice } from './DieCutPrinterNotice';
import { LabelCellPreview } from './LabelCellPreview';
import { LabelSizeControls, type LabelSizeValue } from './LabelSizeControls';
import { SheetLayoutControls } from './SheetLayoutControls';

/**
 * Batch label-sheet preview & print (spec §6 "Printable QR generation"; Phase 73
 * "Label customisation").
 *
 * Phase 49 printed a fixed grid of QR-plus-name labels for the multi-select flow.
 * This now drives a customisable {@link LabelTemplate}: the symbology (QR / Code 128
 * barcode / both / none), which item fields the text block shows, and the columns per
 * sheet. The dialog edits a **working copy** seeded from the device-local default
 * (`usePreferencesStore.labelTemplate`); "Save as default" persists it. The live
 * preview and the printed sheet share {@link toLabelCells}, so what you see is what
 * prints (the pure {@link buildLabelSheetHtml} is opened in a fresh print window).
 */
/**
 * A compact stacked label + {@link Select} combobox for the template controls. The
 * combobox (a `role="combobox"`, not a labelable control) is named via a sibling label
 * span so the small muted caption above it still associates.
 */
function CompactSelect({ label, ...props }: { label: string } & Omit<SelectProps, 'aria-labelledby'>) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-field-gap-compact text-xs font-medium text-muted-foreground">
      <span id={labelId}>{label}</span>
      <Select aria-labelledby={labelId} {...props} />
    </div>
  );
}

export function PrintLabelsDialog({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly LabelItem[];
}) {
  const t = useT();
  const storedTemplate = usePreferencesStore((s) => s.labelTemplate);
  const setLabelTemplate = usePreferencesStore((s) => s.setLabelTemplate);
  const labelBaseUrl = usePreferencesStore((s) => s.labelBaseUrl);

  // Editable working copy, re-seeded from the saved default each time the dialog opens.
  const [template, setTemplate] = useState<LabelTemplate>(() => normaliseLabelTemplate(storedTemplate));
  useEffect(() => {
    if (open) setTemplate(normaliseLabelTemplate(storedTemplate));
  }, [open, storedTemplate]);

  const baseUrl = useMemo(
    () =>
      resolveLabelBaseUrl(
        labelBaseUrl,
        typeof window === 'undefined' ? null : window.location.origin,
        import.meta.env.BASE_URL,
      ),
    [labelBaseUrl],
  );

  const cells = useMemo(() => toLabelCells(items, baseUrl, template), [items, baseUrl, template]);
  // The template's size fields in the shape the size control, the printer notice and the
  // preview all take, so the three can't disagree about what is being printed.
  const size: LabelSizeValue = {
    sizeMode: template.sizeMode,
    widthMm: template.labelWidthMm,
    heightMm: template.labelHeightMm,
  };
  const truncated = items.length > MAX_LABELS;
  // The template asks for QR codes but none encoded — the deep-link is too long, which only the
  // "Link host" setting can cause. Say so here rather than printing a sheet of code-less labels.
  const qrTooLong = templateHasQr(template) && cells.length > 0 && cells.every((c) => c.qrSvg === null);
  // Code 128 needs a minimum bar width to scan, so a label this narrow can't carry one at
  // all — and an MPN too long for the space falls back to a short item code (issue #331).
  // Say which, rather than silently printing a different code or none. A sheet can be in
  // both states at once (symbol width depends on the value, not just the label), so the two
  // are independent rather than exclusive.
  const barcodeTooNarrow = cells.some((c) => c.barcodeFit === 'unprintable');
  const barcodeShortened = cells.some((c) => c.barcodeFit === 'shortened');
  // A QR's module count comes from its deep-link, so a small label divides a fixed number of
  // modules into less and less space until a phone camera can't resolve them. It is still
  // printed — a QR can't be shortened the way a barcode's value can, and it is usually the only
  // code on the label — but the user gets to hear about it before the sticker is on a box (#330).
  const qrTooSmall = cells.some((c) => c.qrFit === 'tooSmall');
  const dirty = useMemo(
    () => JSON.stringify(template) !== JSON.stringify(normaliseLabelTemplate(storedTemplate)),
    [template, storedTemplate],
  );

  const set = <K extends keyof LabelTemplate>(key: K, value: LabelTemplate[K]) =>
    setTemplate((t) => ({ ...t, [key]: value }));

  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    w.document.write(buildLabelSheetHtml(items, baseUrl, template));
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Print labels"
      description={`${cells.length} ${plural(cells.length, 'label')}`}
    >
      <div className="space-y-4">
        {truncated ? (
          <Banner tone="warning">
            {items.length} items selected — printing the first {MAX_LABELS}.
          </Banner>
        ) : null}

        {qrTooLong ? (
          <Banner tone="warning" data-testid="labels-qr-too-long">
            {t('inventory.qr.tooLongLabels')}
          </Banner>
        ) : null}

        {qrTooSmall ? (
          <Banner tone="warning" data-testid="labels-qr-too-small">
            {t('inventory.labels.qrTooSmallItems')}
          </Banner>
        ) : null}

        {barcodeTooNarrow ? (
          <Banner tone="warning" data-testid="labels-barcode-too-narrow">
            {t('inventory.labels.barcodeTooNarrow')}
          </Banner>
        ) : null}

        {barcodeShortened ? (
          <Banner tone="warning" data-testid="labels-barcode-shortened">
            {t('inventory.labels.barcodeShortenedItems')}
          </Banner>
        ) : null}

        {/* An exact-millimetre page needs a printer loaded with that exact label (issue #337). */}
        <DieCutPrinterNotice size={size} testId="labels-die-cut-printer" />

        {/* Template controls */}
        <div className="grid gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-2">
          <LabelSizeControls
            value={size}
            onChange={(v) =>
              setTemplate((t) => ({
                ...t,
                sizeMode: v.sizeMode,
                labelWidthMm: v.widthMm,
                labelHeightMm: v.heightMm,
              }))
            }
          />

          <CompactSelect
            label="Code"
            value={template.symbology}
            onChange={(value) => set('symbology', value as LabelSymbology)}
            data-testid="label-symbology"
            options={LABEL_SYMBOLOGY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />

          {template.sizeMode === 'sheet' ? (
            <SheetLayoutControls
              testId="label-sheet-layout"
              value={template.sheet}
              onChange={(sheet) => set('sheet', sheet)}
            />
          ) : null}

          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="text-xs font-medium text-muted-foreground">Show on label</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <FieldToggle label="Name" checked={template.showName} onChange={(v) => set('showName', v)} />
              <FieldToggle label="MPN" checked={template.showMpn} onChange={(v) => set('showMpn', v)} />
              <FieldToggle
                label="Location"
                checked={template.showLocation}
                onChange={(v) => set('showLocation', v)}
              />
              <FieldToggle
                label="Quantity"
                checked={template.showQuantity}
                onChange={(v) => set('showQuantity', v)}
              />
              {/* The fallback identifier — the one line that still names the record when the
                  code itself is damaged (issue #338), so it carries its own explanation. */}
              <FieldToggle
                label={t('inventory.labels.showShortCode')}
                hint={t('inventory.labels.showShortCodeHint')}
                checked={template.showShortId}
                onChange={(v) => set('showShortId', v)}
                testId="label-show-short-code"
              />
              {templateHasBarcode(template) ? (
                <FieldToggle
                  label="Barcode text"
                  checked={template.showText}
                  onChange={(v) => set('showText', v)}
                />
              ) : null}
            </div>
          </fieldset>
        </div>

        {cells.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No items selected.</p>
        ) : (
          <div
            data-testid="label-sheet-preview"
            className="grid max-h-[45vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3"
          >
            {cells.map((cell, i) => (
              <LabelCellPreview
                key={`${cell.id}-${i}`}
                cell={cell}
                // A sheet label now has a definite printed size too (its row height is fixed,
                // so the grid can't stretch to fit its contents), and the preview shows that
                // same shape — otherwise it would flatter a label the stock has no room for.
                size={template.sizeMode === 'die-cut' ? size : sheetCellSizeMm(template.sheet)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setLabelTemplate(template)}
            disabled={!dirty}
            data-testid="label-save-default"
          >
            Save as default
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={print} disabled={cells.length === 0} data-testid="print-labels-confirm">
            <PrintIcon />
            Print {cells.length} {plural(cells.length, 'label')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FieldToggle({
  label,
  checked,
  onChange,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Rich-Markdown help shown in an {@link InfoHint} badge beside the label. */
  hint?: string;
  testId?: string;
}) {
  const toggle = (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5"
        data-testid={testId}
      />
      {label}
    </label>
  );
  // The badge sits *outside* the label so tapping it opens the tooltip rather than
  // toggling the checkbox.
  return hint ? (
    <span className="flex items-center gap-1.5">
      {toggle}
      <InfoHint content={hint} />
    </span>
  ) : (
    toggle
  );
}
