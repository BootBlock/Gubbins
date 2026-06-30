import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, Modal, Select } from '@/components/foundry';
import { PrintIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  LABEL_COLUMNS_BOUNDS,
  LABEL_SYMBOLOGY_OPTIONS,
  normaliseLabelTemplate,
  templateHasBarcode,
  type LabelSymbology,
  type LabelTemplate,
} from '../labels/label-template';
import { MAX_LABELS, buildLabelSheetHtml, toLabelCells, type LabelItem } from '../labels/label-sheet';
import { LabelCellPreview } from './LabelCellPreview';

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
export function PrintLabelsDialog({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly LabelItem[];
}) {
  const storedTemplate = usePreferencesStore((s) => s.labelTemplate);
  const setLabelTemplate = usePreferencesStore((s) => s.setLabelTemplate);

  // Editable working copy, re-seeded from the saved default each time the dialog opens.
  const [template, setTemplate] = useState<LabelTemplate>(() => normaliseLabelTemplate(storedTemplate));
  useEffect(() => {
    if (open) setTemplate(normaliseLabelTemplate(storedTemplate));
  }, [open, storedTemplate]);

  const baseUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    try {
      return new URL(import.meta.env.BASE_URL, window.location.origin).href;
    } catch {
      return '#';
    }
  }, []);

  const cells = useMemo(() => toLabelCells(items, baseUrl, template), [items, baseUrl, template]);
  const truncated = items.length > MAX_LABELS;
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
      description={`${cells.length} label${cells.length === 1 ? '' : 's'}`}
    >
      <div className="space-y-4">
        {truncated ? (
          <Banner tone="warning">
            {items.length} items selected — printing the first {MAX_LABELS}.
          </Banner>
        ) : null}

        {/* Template controls */}
        <div className="grid gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Code
            <Select
              value={template.symbology}
              onChange={(e) => set('symbology', e.target.value as LabelSymbology)}
              data-testid="label-symbology"
            >
              {LABEL_SYMBOLOGY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Columns per sheet
            <Select
              value={String(template.columns)}
              onChange={(e) => set('columns', Number(e.target.value))}
              data-testid="label-columns"
            >
              {columnOptions().map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>

          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="text-xs font-medium text-muted-foreground">Show on label</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <FieldToggle label="Name" checked={template.showName} onChange={(v) => set('showName', v)} />
              <FieldToggle label="MPN" checked={template.showMpn} onChange={(v) => set('showMpn', v)} />
              <FieldToggle label="Location" checked={template.showLocation} onChange={(v) => set('showLocation', v)} />
              <FieldToggle label="Quantity" checked={template.showQuantity} onChange={(v) => set('showQuantity', v)} />
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
            className="grid max-h-[45vh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-3"
          >
            {cells.map((cell, i) => (
              <LabelCellPreview key={`${cell.id}-${i}`} cell={cell} />
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
            Print {cells.length} label{cells.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function columnOptions(): number[] {
  const out: number[] = [];
  for (let n = LABEL_COLUMNS_BOUNDS.min; n <= LABEL_COLUMNS_BOUNDS.max; n += 1) out.push(n);
  return out;
}

function FieldToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-primary"
      />
      {label}
    </label>
  );
}
