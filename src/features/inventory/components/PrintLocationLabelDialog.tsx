import { useEffect, useId, useMemo, useState } from 'react';
import { Banner, Button, InfoHint, Modal, Select, type SelectProps } from '@/components/foundry';
import { PrintIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { resolveLabelBaseUrl } from '@/features/scanner/scan-payload';
import { useT } from '@/features/i18n';
import {
  LABEL_COLUMNS_BOUNDS,
  LABEL_SYMBOLOGY_OPTIONS,
  normaliseLabelTemplate,
  type LabelSizeMode,
  type LabelSymbology,
  type LabelTemplate,
} from '../labels/label-template';
import {
  buildLocationLabelHtml,
  toLocationLabelCell,
  type LocationLabelInput,
} from '../labels/location-label';
import { LabelCellPreview } from './LabelCellPreview';
import { LabelSizeControls } from './LabelSizeControls';

const COPY_OPTIONS = [1, 2, 4, 6, 8, 12, 24];

/** Rich-Markdown help for the **Code** (symbology) picker. */
const CODE_HINT = [
  'The machine-readable code printed on the label.',
  '',
  '- **QR** — a 2-D square encoding a **deep-link to this location**, so scanning it jumps',
  '  straight to the bin/shelf in Gubbins. The fastest to scan with a **phone camera**, the',
  '  most forgiving of small print sizes, and the usual choice.',
  '- **Barcode (Code 128)** — a 1-D barcode carrying the **location name** for a',
  '  **laser/linear barcode scanner**; suits existing warehouse-style hardware, but needs',
  '  far more width. A name too long for the label falls back to a short code.',
  '- **QR + barcode** prints both, for a location read by either kind of scanner.',
].join('\n');

/** Rich-Markdown help for the **Copies** picker. */
const COPIES_HINT = [
  'How many **identical copies** of this one location label to print.',
  '',
  'Raise it to run off a strip of duplicates for the same bin — one per shelf face,',
  'or a few spares to replace labels that wear off.',
].join('\n');

/** Rich-Markdown help for the **Columns per sheet** picker. */
const COLUMNS_HINT = [
  'How many labels sit **across a row** when tiling onto an **A4 sheet** of ordinary',
  'paper. This sets the printed label size: **more columns → smaller labels**, fewer',
  'columns → larger ones.',
  '',
  'Match it to your sticker sheet, or pick a count that gives a comfortable size for',
  'the QR/barcode to scan reliably. (Hidden for die-cut / thermal label sizes, which',
  'print one label per page.)',
].join('\n');

/** Rich-Markdown help for the **Show full path** toggle. */
const SHOW_PATH_HINT = [
  'Print the **ancestor path** above the location name — e.g. *Garage ▸ Shelf B* — not',
  'just the location itself.',
  '',
  'Keep it on to tell **same-named bins apart** at a glance; turn it off for a cleaner,',
  'larger name when the label is small or the location is unambiguous.',
].join('\n');

/**
 * A compact stacked label + {@link Select} combobox for this dialog's print settings.
 * The combobox (a `role="combobox"`, not a labelable control) is named via a sibling
 * label span so the small muted caption above it still associates. An optional
 * {@link InfoHint} badge sits beside the caption to explain the setting.
 */
function CompactSelect({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & Omit<SelectProps, 'aria-labelledby'>) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span className="flex items-center gap-1">
        <span id={labelId}>{label}</span>
        {hint ? <InfoHint content={hint} /> : null}
      </span>
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
  const t = useT();
  const storedTemplate = usePreferencesStore((s) => s.labelTemplate);
  const labelBaseUrl = usePreferencesStore((s) => s.labelBaseUrl);

  // A location label only uses symbology / columns / showName / showLocation(path);
  // the item-only field flags are forced on/off so the shared renderer behaves.
  const [symbology, setSymbology] = useState<LabelSymbology>('qr');
  const [columns, setColumns] = useState(1);
  const [showPath, setShowPath] = useState(true);
  const [copies, setCopies] = useState(1);
  const [sizeMode, setSizeMode] = useState<LabelSizeMode>('sheet');
  const [labelWidthMm, setLabelWidthMm] = useState(40);
  const [labelHeightMm, setLabelHeightMm] = useState(30);
  useEffect(() => {
    if (!open) return;
    const seed = normaliseLabelTemplate(storedTemplate);
    setSymbology(seed.symbology === 'none' ? 'qr' : seed.symbology);
    setColumns(seed.columns);
    setShowPath(true);
    setCopies(1);
    setSizeMode(seed.sizeMode);
    setLabelWidthMm(seed.labelWidthMm);
    setLabelHeightMm(seed.labelHeightMm);
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

  const template: LabelTemplate = useMemo(
    () => ({
      symbology,
      columns,
      showName: true,
      showLocation: showPath,
      showMpn: false,
      showQuantity: false,
      showText: true,
      sizeMode,
      labelWidthMm,
      labelHeightMm,
    }),
    [symbology, columns, showPath, sizeMode, labelWidthMm, labelHeightMm],
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
    <Modal
      open={open}
      onClose={onClose}
      title="Print location label"
      description={location.name}
      className="max-w-[38.4rem]"
    >
      <div className="space-y-4">
        {/* Code 128 needs a minimum bar width to scan: a long location name would print as a
            smear, so it falls back to a short code — and a very narrow label can't carry a
            barcode at all. Say which, rather than quietly printing something else (#331). */}
        {cell.barcodeFit === 'unprintable' ? (
          <Banner tone="warning" data-testid="loc-label-barcode-too-narrow">
            {t('inventory.labels.barcodeTooNarrow')}
          </Banner>
        ) : cell.barcodeFit === 'shortened' ? (
          <Banner tone="warning" data-testid="loc-label-barcode-shortened">
            {t('inventory.labels.barcodeShortenedLocation')}
          </Banner>
        ) : null}

        <div className="grid gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-2">
          <LabelSizeControls
            testId="loc-label-size"
            value={{ sizeMode, widthMm: labelWidthMm, heightMm: labelHeightMm }}
            onChange={(v) => {
              setSizeMode(v.sizeMode);
              setLabelWidthMm(v.widthMm);
              setLabelHeightMm(v.heightMm);
            }}
          />

          <CompactSelect
            label="Code"
            hint={CODE_HINT}
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
            hint={COPIES_HINT}
            value={String(copies)}
            onChange={(value) => setCopies(Number(value))}
            data-testid="loc-label-copies"
            options={COPY_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />

          {sizeMode === 'sheet' ? (
            <CompactSelect
              label="Columns per sheet"
              hint={COLUMNS_HINT}
              value={String(columns)}
              onChange={(value) => setColumns(Number(value))}
              options={Array.from(
                { length: LABEL_COLUMNS_BOUNDS.max - LABEL_COLUMNS_BOUNDS.min + 1 },
                (_, i) => LABEL_COLUMNS_BOUNDS.min + i,
              ).map((n) => ({ value: String(n), label: String(n) }))}
            />
          ) : null}

          {location.path && location.path.trim().length > 0 ? (
            <div className="flex items-center gap-1 self-end">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={showPath}
                  onChange={(e) => setShowPath(e.target.checked)}
                  className="size-3.5 accent-primary"
                />
                Show full path
              </label>
              <InfoHint content={SHOW_PATH_HINT} />
            </div>
          ) : null}
        </div>

        <div className="mx-auto w-48">
          <LabelCellPreview
            cell={cell}
            size={sizeMode === 'die-cut' ? { widthMm: labelWidthMm, heightMm: labelHeightMm } : undefined}
          />
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
