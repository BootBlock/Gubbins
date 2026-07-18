import { useId, useRef, useState } from 'react';
import { Banner, Button, FormField, Input, Modal, Money, Select, Textarea } from '@/components/foundry';
import { UploadIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useT } from '@/features/i18n';
import {
  detectImportFormat,
  IMPORT_FORMATS,
  IMPORT_FORMAT_LABELS,
  type ImportFormat,
} from '@/features/import/tabular';
import {
  parsePurchaseList,
  purchaseLineLabel,
  PurchaseListImportError,
  type ParsedPurchaseListLine,
} from '../purchase-list-import';
import {
  useCreateOrderFromPurchaseList,
  useImportPurchaseListIntoOrder,
  useImportPurchaseListIntoWishlist,
  type PurchaseListImportSummary,
} from '../purchase-list-queries';

/** The file types the purchase-list importer accepts (mirrors the recognised formats). */
const PURCHASE_LIST_FILE_ACCEPT =
  '.csv,.tsv,.tab,.txt,.json,.md,.markdown,.html,.htm,' +
  'text/csv,text/tab-separated-values,text/plain,application/json,text/markdown,text/html';

/** Where an imported list is landed. */
type Destination = 'thisOrder' | 'newOrder' | 'wishlist';

/**
 * Purchase-list ingress (issue #34). The user pastes or uploads a list of things to buy — a
 * supplier basket export, a quote, a spreadsheet of parts, or just one thing typed per line —
 * and it is parsed (format auto-detected, or forced via "Interpret as"), previewed, then landed
 * on whichever purchasing surface they choose:
 *
 *  - **this order** — the lines are added to the open purchase order (only offered when the
 *    dialog is opened from an order).
 *  - **a new order** — a DRAFT order is created for the named supplier and the lines added to it.
 *  - **the wishlist** — each line becomes a wishlist entry, priced at its unit price.
 *
 * All three share one parse + preview, and the format handling is the shared
 * {@link module:features/import/tabular} engine the item and BOM importers use, so every
 * importer in Gubbins understands the same shapes.
 */
export function ImportPurchaseListDialog({
  open,
  onClose,
  poId,
  supplierName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The open purchase order, when the dialog was opened from one. Enables "this order". */
  poId?: string;
  /** That order's supplier, used to seed the new-order supplier field. */
  supplierName?: string;
  /** Called with the new order's id after a successful new-order import. */
  onCreated?: (poId: string) => void;
}) {
  const t = useT();
  const f = useFormatters();
  const formatId = useId();
  const destinationId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const supplierRef = useRef<HTMLInputElement>(null);

  const importIntoOrder = useImportPurchaseListIntoOrder(poId ?? '');
  const createOrder = useCreateOrderFromPurchaseList();
  const importIntoWishlist = useImportPurchaseListIntoWishlist();

  const [destination, setDestination] = useState<Destination>(poId ? 'thisOrder' : 'wishlist');
  const [supplier, setSupplier] = useState(supplierName ?? '');
  const [text, setText] = useState('');
  // 'auto' → detect the source shape from the content; a format id forces that parser.
  const [formatOverride, setFormatOverride] = useState<ImportFormat | 'auto'>('auto');
  const [parsed, setParsed] = useState<ParsedPurchaseListLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const pending = importIntoOrder.isPending || createOrder.isPending || importIntoWishlist.isPending;

  const reset = () => {
    setDestination(poId ? 'thisOrder' : 'wishlist');
    setSupplier(supplierName ?? '');
    setText('');
    setFormatOverride('auto');
    setParsed(null);
    setError(null);
    setSummary(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  // Parse the given text under the given format choice, updating the preview / error. Both the
  // text field and the format picker call this so a change to either re-parses live.
  const runParse = (raw: string, override: ImportFormat | 'auto') => {
    setText(raw);
    setSummary(null);
    if (raw.trim().length === 0) {
      setParsed(null);
      setError(null);
      return;
    }
    try {
      setParsed(parsePurchaseList(raw, override === 'auto' ? {} : { format: override }));
      setError(null);
    } catch (err) {
      setParsed(null);
      setError(err instanceof PurchaseListImportError ? err.message : t('purchasing.import.error.parse'));
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    runParse(await file.text(), formatOverride);
  };

  // When auto-detecting, show which shape was recognised. Unlike a BOM, a free-form list is a
  // legitimate outcome here, so every detected format is worth reporting.
  const detectedFormat =
    formatOverride === 'auto' && text.trim().length > 0 ? detectImportFormat(text) : null;

  /** Report what landed, and clear the staged text so the dialog is ready for another paste. */
  const announce = (result: PurchaseListImportSummary) => {
    const key = result.skipped > 0 ? 'purchasing.import.doneSkipped' : 'purchasing.import.done';
    setSummary(t(key, { vars: { count: result.added, skipped: result.skipped } }));
    setParsed(null);
    setText('');
  };

  const failWith = (
    err: unknown,
    fallbackKey: 'purchasing.import.error.order' | 'purchasing.import.error.wishlist',
  ) => {
    setError(err instanceof Error ? err.message : t(fallbackKey));
  };

  const handleImport = () => {
    if (!parsed || parsed.length === 0) return;
    setError(null);

    if (destination === 'wishlist') {
      importIntoWishlist.mutate(parsed, {
        onSuccess: announce,
        onError: (err) => failWith(err, 'purchasing.import.error.wishlist'),
      });
      return;
    }

    if (destination === 'newOrder') {
      const trimmed = supplier.trim();
      if (trimmed.length === 0) {
        supplierRef.current?.focus();
        return;
      }
      createOrder.mutate(
        { supplierName: trimmed, lines: parsed },
        {
          onSuccess: (result) => {
            onCreated?.(result.poId);
            close();
          },
          onError: (err) => failWith(err, 'purchasing.import.error.order'),
        },
      );
      return;
    }

    importIntoOrder.mutate(parsed, {
      onSuccess: announce,
      onError: (err) => failWith(err, 'purchasing.import.error.order'),
    });
  };

  const supplierMissing = destination === 'newOrder' && supplier.trim().length === 0;

  const destinationOptions = [
    ...(poId ? [{ value: 'thisOrder', label: t('purchasing.import.destination.thisOrder') }] : []),
    { value: 'newOrder', label: t('purchasing.import.destination.newOrder') },
    { value: 'wishlist', label: t('purchasing.import.destination.wishlist') },
  ];

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('purchasing.import.title')}
      description={t('purchasing.import.description')}
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="space-y-field-gap-compact">
          <span
            id={`${destinationId}-label`}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('purchasing.import.destination.label')}
          </span>
          <Select
            id={destinationId}
            aria-labelledby={`${destinationId}-label`}
            value={destination}
            onChange={(value) => setDestination(value as Destination)}
            data-testid="purchase-import-destination"
            options={destinationOptions}
          />
        </div>

        {destination === 'newOrder' ? (
          <FormField
            label={t('purchasing.import.supplier.label')}
            hint={t('purchasing.import.supplier.hint')}
          >
            <Input
              ref={supplierRef}
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder={t('purchasing.import.supplier.placeholder')}
              data-testid="purchase-import-supplier"
            />
          </FormField>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <UploadIcon />
              {t('purchasing.import.upload')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('purchasing.import.orPaste')}</span>
            <input
              ref={fileRef}
              type="file"
              accept={PURCHASE_LIST_FILE_ACCEPT}
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </div>
          <div className="ml-auto space-y-field-gap-compact">
            <span
              id={`${formatId}-label`}
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('purchasing.import.interpretAs')}
            </span>
            <Select
              id={formatId}
              aria-labelledby={`${formatId}-label`}
              value={formatOverride}
              onChange={(value) => {
                const next = value as ImportFormat | 'auto';
                setFormatOverride(next);
                runParse(text, next);
              }}
              className="h-8 text-xs"
              data-testid="purchase-import-format"
              options={[
                { value: 'auto', label: t('purchasing.import.autoDetect') },
                ...IMPORT_FORMATS.map((format) => ({
                  value: format,
                  label: IMPORT_FORMAT_LABELS[format],
                })),
              ]}
            />
          </div>
        </div>

        <Textarea
          value={text}
          onChange={(e) => runParse(e.target.value, formatOverride)}
          placeholder={t('purchasing.import.placeholder')}
          className="h-40 font-mono"
          aria-label={t('purchasing.import.textLabel')}
        />

        <p className="text-xs text-muted-foreground">
          {t('purchasing.import.help')}
          {detectedFormat
            ? ` ${t('purchasing.import.detected', { vars: { format: IMPORT_FORMAT_LABELS[detectedFormat] } })}`
            : ''}
        </p>

        {error ? <Banner tone="danger">{error}</Banner> : null}
        {summary ? <Banner tone="success">{summary}</Banner> : null}

        {parsed && parsed.length > 0 ? (
          <div className="max-h-48 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">{t('purchasing.import.column.qty')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('purchasing.import.column.name')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('purchasing.import.column.code')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('purchasing.import.column.unitPrice')}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((line, i) => (
                  <tr key={i} className="border-t border-border/60" data-testid="purchase-import-preview-row">
                    <td className="px-2 py-1.5">{f.quantity(line.quantity)}</td>
                    <td className="px-2 py-1.5">{purchaseLineLabel(line)}</td>
                    <td className="px-2 py-1.5 font-mono">{line.mpn ?? line.supplierSku ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      {line.unitPrice !== null ? <Money value={line.unitPrice} formatters={f} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {parsed ? t('purchasing.import.ready', { vars: { count: parsed.length } }) : ' '}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t('purchasing.import.close')}
            </Button>
            <Button
              type="button"
              onClick={handleImport}
              disabled={!parsed || parsed.length === 0 || supplierMissing || pending}
              data-testid="purchase-import-submit"
            >
              {t('purchasing.import.submit', { vars: { count: parsed?.length ?? 0 } })}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
