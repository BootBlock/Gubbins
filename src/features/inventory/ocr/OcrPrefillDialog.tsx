import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Input, LiveRegion, Modal, Spinner } from '@/components/foundry';
import { ScanIcon } from '@/components/icons';
import { hasAnyCandidate, type ReceiptCandidates } from './receipt-ocr';
import { useReceiptOcr } from './useReceiptOcr';
import type { OcrRecognizerFactory } from './ocr-engine';

/**
 * Reviewable on-device receipt / label OCR prefill (feature-gap **G2**).
 *
 * The user photographs a receipt or product label; an offline, keyless Tesseract WASM engine
 * ({@link ./ocr-engine}, run via {@link useReceiptOcr}) reads it and the pure
 * {@link ./receipt-ocr} seam extracts candidate fields (price, acquired date, model/MPN,
 * serial). Those are shown here as **editable, individually-toggleable rows** — nothing is
 * written to the item until the user presses *Apply*, and the parent still fills only blank
 * fields. This dialog never touches the database; it just hands a reviewed
 * {@link OcrPrefill} back to the add-item form.
 */

/** The reviewed values the user chose to apply, as form-ready strings (blank = don't apply). */
export interface OcrPrefill {
  /** Unit cost / price, a decimal string. */
  readonly unitCost?: string;
  /** Acquired date as `YYYY-MM-DD`. */
  readonly acquiredAt?: string;
  /** Model / manufacturer part number. */
  readonly mpn?: string;
  /** Serial number (the form has no serial field, so the parent records it in notes). */
  readonly serial?: string;
}

type DraftKey = 'price' | 'acquiredAt' | 'mpn' | 'serial';

interface DraftRow {
  readonly include: boolean;
  readonly value: string;
  /** The raw OCR line the value came from — shown for the user to sanity-check against. */
  readonly source: string;
}

type Draft = Partial<Record<DraftKey, DraftRow>>;

/** Seed the editable review rows from the parsed candidates (all included by default). */
function draftFromCandidates(candidates: ReceiptCandidates): Draft {
  const draft: Draft = {};
  if (candidates.price) {
    draft.price = {
      include: true,
      value: String(candidates.price.value.amount),
      source: candidates.price.source,
    };
  }
  if (candidates.acquiredAt) {
    draft.acquiredAt = {
      include: true,
      value: candidates.acquiredAt.value,
      source: candidates.acquiredAt.source,
    };
  }
  if (candidates.mpn) {
    draft.mpn = { include: true, value: candidates.mpn.value, source: candidates.mpn.source };
  }
  if (candidates.serial) {
    draft.serial = { include: true, value: candidates.serial.value, source: candidates.serial.source };
  }
  return draft;
}

/** Currency label suffix, e.g. " (GBP)", when a currency was detected. */
function currencySuffix(candidates: ReceiptCandidates): string {
  const currency = candidates.price?.value.currency;
  return currency ? ` (${currency})` : '';
}

export function OcrPrefillDialog({
  open,
  onClose,
  onApply,
  createRecognizer,
}: {
  open: boolean;
  onClose: () => void;
  /** Hand the reviewed values back to the add-item form (it fills only its blank fields). */
  onApply: (prefill: OcrPrefill) => void;
  /** Injectable recogniser factory — production uses the real Tesseract engine; tests a fake. */
  createRecognizer?: OcrRecognizerFactory;
}) {
  const ocr = useReceiptOcr(createRecognizer ? { createRecognizer } : undefined);
  const [draft, setDraft] = useState<Draft>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Seed the editable rows once a pass completes.
  useEffect(() => {
    if (ocr.phase === 'done' && ocr.candidates) setDraft(draftFromCandidates(ocr.candidates));
  }, [ocr.phase, ocr.candidates]);

  const close = () => {
    ocr.reset();
    setDraft({});
    onClose();
  };

  const rescan = () => {
    ocr.reset();
    setDraft({});
    fileInputRef.current?.click();
  };

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so re-picking the same file fires `change` again.
    event.target.value = '';
    if (file) void ocr.scan(file);
  };

  const setRow = (key: DraftKey, patch: Partial<DraftRow>) =>
    setDraft((d) => (d[key] ? { ...d, [key]: { ...d[key]!, ...patch } } : d));

  const apply = () => {
    const take = (key: DraftKey): string | undefined => {
      const row = draft[key];
      const value = row?.value.trim();
      return row?.include && value ? value : undefined;
    };
    const unitCost = take('price');
    const acquiredAt = take('acquiredAt');
    const mpn = take('mpn');
    const serial = take('serial');
    onApply({
      ...(unitCost ? { unitCost } : {}),
      ...(acquiredAt ? { acquiredAt } : {}),
      ...(mpn ? { mpn } : {}),
      ...(serial ? { serial } : {}),
    });
    close();
  };

  const anySelected = (['price', 'acquiredAt', 'mpn', 'serial'] as const).some(
    (k) => draft[k]?.include && draft[k]?.value.trim(),
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title="Scan a receipt or label"
      description="Reads a photo on your device and pre-fills the fields below for you to review — nothing is saved until you apply and create the item."
      className="max-w-lg"
    >
      <div className="space-y-4">
        {/* Hidden native file input; the visible control is the labelled button below. On a
            phone `capture` opens the camera directly. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Receipt or label photo"
          className="sr-only"
          data-testid="ocr-file-input"
          onChange={onPickFile}
        />

        {ocr.phase === 'idle' ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">
              Take or choose a photo of a receipt or product label. Recognition runs entirely on your device —
              nothing is uploaded.
            </p>
            <Button onClick={() => fileInputRef.current?.click()} data-testid="ocr-choose-photo">
              <ScanIcon aria-hidden />
              Choose a photo
            </Button>
          </div>
        ) : null}

        {ocr.phase === 'running' ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <Spinner />
            <LiveRegion className="text-sm text-muted-foreground" data-testid="ocr-progress">
              {ocr.statusLabel}
              {ocr.progress > 0 ? ` ${Math.round(ocr.progress * 100)}%` : ''}
            </LiveRegion>
          </div>
        ) : null}

        {ocr.phase === 'error' ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive" data-testid="ocr-error">
              {ocr.error}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button onClick={rescan}>Try another photo</Button>
            </div>
          </div>
        ) : null}

        {ocr.phase === 'done' && ocr.candidates ? (
          hasAnyCandidate(ocr.candidates) ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Review what was read, untick anything wrong, then apply. Only empty fields on the form are
                filled.
              </p>
              <div className="space-y-3" data-testid="ocr-results">
                {draft.price ? (
                  <ReviewRow
                    label={`Price${currencySuffix(ocr.candidates)}`}
                    row={draft.price}
                    onToggle={(include) => setRow('price', { include })}
                  >
                    <Input
                      inputMode="decimal"
                      value={draft.price.value}
                      onChange={(e) => setRow('price', { value: e.target.value })}
                      aria-label="Price"
                      data-testid="ocr-value-price"
                    />
                  </ReviewRow>
                ) : null}
                {draft.acquiredAt ? (
                  <ReviewRow
                    label="Acquired date"
                    row={draft.acquiredAt}
                    onToggle={(include) => setRow('acquiredAt', { include })}
                  >
                    <Input
                      type="date"
                      value={draft.acquiredAt.value}
                      onChange={(e) => setRow('acquiredAt', { value: e.target.value })}
                      aria-label="Acquired date"
                      data-testid="ocr-value-acquired"
                    />
                  </ReviewRow>
                ) : null}
                {draft.mpn ? (
                  <ReviewRow
                    label="Model / MPN"
                    row={draft.mpn}
                    onToggle={(include) => setRow('mpn', { include })}
                  >
                    <Input
                      value={draft.mpn.value}
                      onChange={(e) => setRow('mpn', { value: e.target.value })}
                      aria-label="Model or MPN"
                      data-testid="ocr-value-mpn"
                    />
                  </ReviewRow>
                ) : null}
                {draft.serial ? (
                  <ReviewRow
                    label="Serial number"
                    row={draft.serial}
                    onToggle={(include) => setRow('serial', { include })}
                  >
                    <Input
                      value={draft.serial.value}
                      onChange={(e) => setRow('serial', { value: e.target.value })}
                      aria-label="Serial number"
                      data-testid="ocr-value-serial"
                    />
                  </ReviewRow>
                ) : null}
              </div>
              <div className="flex justify-between gap-2">
                <Button variant="ghost" onClick={rescan}>
                  Scan another
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                  <Button onClick={apply} disabled={!anySelected} data-testid="ocr-apply">
                    Apply to form
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground" data-testid="ocr-empty">
                Couldn’t read any details from that image. Try a clearer, well-lit, straight-on photo.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={rescan}>Try another photo</Button>
              </div>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * One reviewable field: an "include" checkbox beside the label, the editable control below it,
 * and the source line it was read from. The control carries its own `aria-label` (passed by the
 * caller), so the checkbox-in-label pattern doesn't double-label it.
 */
function ReviewRow({
  label,
  row,
  onToggle,
  children,
}: {
  label: string;
  row: DraftRow;
  onToggle: (include: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-field-gap-compact rounded-lg border border-border bg-secondary/20 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={row.include}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Apply ${label}`}
        />
        {label}
      </label>
      {children}
      <p className="truncate text-xs text-muted-foreground">Read from: “{row.source}”</p>
    </div>
  );
}
