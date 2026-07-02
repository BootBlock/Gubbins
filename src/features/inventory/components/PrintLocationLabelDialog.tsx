import { useEffect, useId, useMemo, useState } from 'react';
import { Button, Modal, Select, type SelectProps } from '@/components/foundry';
import { PrintIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  LABEL_COLUMNS_BOUNDS,
  LABEL_SYMBOLOGY_OPTIONS,
  normaliseLabelTemplate,
  type LabelSymbology,
  type LabelTemplate,
} from '../labels/label-template';
import {
  buildLocationLabelHtml,
  toLocationLabelCell,
  type LocationLabelInput,
} from '../labels/location-label';
import { LabelCellPreview } from './LabelCellPreview';

const COPY_OPTIONS = [1, 2, 4, 6, 8, 12, 24];

/**
 * A compact stacked label + {@link Select} combobox for this dialog's print settings.
 * The combobox (a `role="combobox"`, not a labelable control) is named via a sibling
 * label span so the small muted caption above it still associates.
 */
function CompactSelect({ label, ...props }: { label: string } & Omit<SelectProps, 'aria-labelledby'>) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span id={labelId}>{label}</span>
      <Select aria-labelledby={labelId} {...props} />
    </div>
  );
}

/**
 * Print a customisable label for a single **location** (Phase 73). The QR/Code-128
 * encodes the location deep-link so a phone camera — or the in-app scanner — jumps to
 * that bin/shelf; the user picks the symbology, whether to show the ancestor path, the
 * columns, and how many copies to print. Seeds its symbology/columns from the
 * device-local default template (`usePreferencesStore.labelTemplate`); the preview and
 * the printed sheet share `toLocationLabelCell`, so what you see is what prints.
 */
export function PrintLocationLabelDialog({
  open,
  onClose,
  location,
}: {
  open: boolean;
  onClose: () => void;
  location: LocationLabelInput;
}) {
  const storedTemplate = usePreferencesStore((s) => s.labelTemplate);

  // A location label only uses symbology / columns / showName / showLocation(path);
  // the item-only field flags are forced on/off so the shared renderer behaves.
  const [symbology, setSymbology] = useState<LabelSymbology>('qr');
  const [columns, setColumns] = useState(1);
  const [showPath, setShowPath] = useState(true);
  const [copies, setCopies] = useState(1);
  useEffect(() => {
    if (!open) return;
    const seed = normaliseLabelTemplate(storedTemplate);
    setSymbology(seed.symbology === 'none' ? 'qr' : seed.symbology);
    setColumns(seed.columns);
    setShowPath(true);
    setCopies(1);
  }, [open, storedTemplate]);

  const baseUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    try {
      return new URL(import.meta.env.BASE_URL, window.location.origin).href;
    } catch {
      return '#';
    }
  }, []);

  const template: LabelTemplate = useMemo(
    () => ({
      symbology,
      columns,
      showName: true,
      showLocation: showPath,
      showMpn: false,
      showQuantity: false,
      showText: true,
    }),
    [symbology, columns, showPath],
  );

  const cell = useMemo(() => toLocationLabelCell(location, baseUrl, template), [location, baseUrl, template]);

  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    w.document.write(buildLocationLabelHtml(location, baseUrl, template, copies));
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Modal open={open} onClose={onClose} title="Print location label" description={location.name}>
      <div className="space-y-4">
        <div className="grid gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-2">
          <CompactSelect
            label="Code"
            value={symbology}
            onChange={(value) => setSymbology(value as LabelSymbology)}
            data-testid="loc-label-symbology"
            options={LABEL_SYMBOLOGY_OPTIONS.filter((o) => o.value !== 'none').map((o) => ({
              value: o.value,
              label: o.label,
            }))}
          />

          <CompactSelect
            label="Copies"
            value={String(copies)}
            onChange={(value) => setCopies(Number(value))}
            data-testid="loc-label-copies"
            options={COPY_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />

          <CompactSelect
            label="Columns per sheet"
            value={String(columns)}
            onChange={(value) => setColumns(Number(value))}
            options={Array.from(
              { length: LABEL_COLUMNS_BOUNDS.max - LABEL_COLUMNS_BOUNDS.min + 1 },
              (_, i) => LABEL_COLUMNS_BOUNDS.min + i,
            ).map((n) => ({ value: String(n), label: String(n) }))}
          />

          {location.path && location.path.trim().length > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 self-end text-sm text-foreground">
              <input
                type="checkbox"
                checked={showPath}
                onChange={(e) => setShowPath(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Show full path
            </label>
          ) : null}
        </div>

        <div className="mx-auto w-40">
          <LabelCellPreview cell={cell} />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={print} data-testid="print-location-label-confirm">
            <PrintIcon />
            Print {copies > 1 ? `${copies} labels` : 'label'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
