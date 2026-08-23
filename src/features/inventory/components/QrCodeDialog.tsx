import { useEffect, useId, useMemo, useState } from 'react';
import { Button, Modal, Select } from '@/components/foundry';
import { CloseIcon, DownloadIcon, NfcIcon, PrintIcon, SuccessIcon } from '@/components/icons';
import { download } from '@/features/export/download';
import { buildItemQrUrl, resolveLabelBaseUrl } from '@/features/scanner/scan-payload';
import { qrSvgOrNull } from '@/features/scanner/qr-code';
import { useT } from '@/features/i18n';
import { useNfcWrite } from '@/features/scanner/useNfcWrite';
import { useFeature } from '@/features/modules/useFeature';
import { code128Svg } from '../labels/code128';
import {
  BARCODE_QUIET_ZONE_MODULES,
  LABEL_SYMBOLOGY_OPTIONS,
  fitBarcodeValue,
  normaliseLabelTemplate,
  shortId,
  type LabelSymbology,
} from '../labels/label-template';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * Printable code for an item (spec §5, Phase 6; multi-symbology Phase 73). The QR
 * encodes the deep-link URL `…/Gubbins/#/inventory?item=<id>` (the §2.4.3 lean
 * hand-rolled encoder) so a phone camera opens the app to the item and Gubbins' own
 * scanner parses the id back out; the Code 128 barcode encodes the item's MPN/SKU
 * (falling back to a short id) for a handheld lookup. The symbology defaults to the
 * device-local label template and can be switched here; offers print + SVG download.
 */
export function QrCodeDialog({
  open,
  onClose,
  itemId,
  itemName,
  itemMpn,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  itemName: string;
  itemMpn?: string | null;
}) {
  const t = useT();
  const defaultSymbology = usePreferencesStore((s) => s.labelTemplate.symbology);
  // The fallback identifier the sheet labels print (issue #338), governed by the same device
  // preference so one setting decides it everywhere a label is produced. Normalised on read, so
  // a template saved before the flag existed still gets the line.
  const showShortCode = usePreferencesStore((s) => normaliseLabelTemplate(s.labelTemplate).showShortId);
  const labelBaseUrl = usePreferencesStore((s) => s.labelBaseUrl);
  // Seed from the saved default, coercing 'none' (meaningless for a single-code dialog)
  // and any stale/garbage persisted value to QR.
  const [symbology, setSymbology] = useState<LabelSymbology>(() => seedSymbology(defaultSymbology));
  const symbologyLabelId = useId();
  useEffect(() => {
    if (open) setSymbology(seedSymbology(defaultSymbology));
  }, [open, defaultSymbology]);

  const baseUrl = useMemo(
    () =>
      resolveLabelBaseUrl(
        labelBaseUrl,
        typeof window === 'undefined' ? null : window.location.origin,
        import.meta.env.BASE_URL,
      ),
    [labelBaseUrl],
  );

  const url = useMemo(() => buildItemQrUrl(itemId, baseUrl), [itemId, baseUrl]);
  // The barcode carries the MPN/SKU where it can, but Code 128 is 11 modules per character
  // and the print stylesheet below caps the symbol at PRINTED_BARCODE_MM — so a very long
  // MPN falls back to a short id rather than printing as an unscannable smear (issue #331).
  const barcode128 = useMemo(
    () => fitBarcodeValue(itemMpn ?? '', itemId, PRINTED_BARCODE_MM),
    [itemId, itemMpn],
  );

  // Write-to-NFC-tag (issue #71): the same deep-link the QR encodes, written to a blank tag so a
  // later tap resolves it exactly like scanning the printed code. Only offered when the NFC
  // capability is on and the device supports Web NFC (Android Chromium); inert otherwise. The
  // armed write is cancelled whenever the dialog closes so it never lingers waiting for a tap.
  const nfcEnabled = useFeature('nfc');
  const { supported: nfcSupported, status: nfcStatus, error: nfcError, write, cancel } = useNfcWrite();
  const nfcWritable = nfcEnabled && nfcSupported;
  useEffect(() => {
    if (!open) cancel();
  }, [open, cancel]);

  const showQr = symbology === 'qr' || symbology === 'both';
  const showBarcode = symbology === 'barcode' || symbology === 'both';

  // Guarded encode: the deep-link's length depends on the user's "Link host" setting, so a
  // payload that won't fit any supported symbol must degrade to an explanation (below) rather
  // than throw out of this render.
  const qr = useMemo(() => (showQr ? qrSvgOrNull(url, { scale: 8 }) : null), [showQr, url]);
  const qrTooLong = showQr && qr === null;
  const barcode = useMemo(() => {
    if (!showBarcode || barcode128.value === null) return null;
    try {
      return code128Svg(barcode128.value, {
        scale: 2,
        height: 64,
        margin: BARCODE_QUIET_ZONE_MODULES,
        showText: true,
      });
    } catch {
      return null;
    }
  }, [showBarcode, barcode128]);
  /** The MPN was too long to print readably, so the barcode carries a short id instead. */
  const barcodeShortened = showBarcode && barcode128.fit === 'shortened';
  /** Whether anything at all encoded — the print/download actions need at least one code. */
  const hasCode = qr !== null || barcode !== null;
  /**
   * The short code to print beneath the label, or `null` when it would say nothing new.
   *
   * This dialog always prints the barcode's human-readable text, so where the barcode has
   * already fallen back to the short id (issue #331) a second identical line is redundant —
   * the same rule the sheet labels apply.
   */
  const printedShortCode = useMemo(() => {
    if (!showShortCode) return null;
    const code = shortId(itemId);
    return barcode !== null && barcode128.value === code ? null : code;
  }, [showShortCode, itemId, barcode, barcode128]);

  const print = () => {
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;
    w.document.write(
      `<!doctype html><title>${escapeHtml(itemName)} — label</title>` +
        `<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}` +
        `h1{font-size:16px;margin:0 0 12px}svg{max-width:${PRINTED_BARCODE_MM}mm}` +
        `.qr svg{width:240px;height:240px}.bc{margin-top:12px}.bc svg{height:80px}` +
        `p{font-size:11px;color:#555;word-break:break-all;margin-top:12px}` +
        // The fallback identifier is set larger and darker than the link beneath it: it is the
        // line someone reads off a damaged label and types in, so it has to survive a photocopy.
        `.code{font-family:ui-monospace,monospace;font-size:14px;letter-spacing:.08em;color:#000}</style>` +
        `<h1>${escapeHtml(itemName)}</h1>` +
        (qr ? `<div class="qr">${qr}</div>` : '') +
        (barcode ? `<div class="bc">${barcode}</div>` : '') +
        (printedShortCode ? `<p class="code">${escapeHtml(printedShortCode)}</p>` : '') +
        (qr ? `<p>${escapeHtml(url)}</p>` : ''),
    );
    w.document.close();
    w.focus();
    w.print();
  };

  const downloadSvg = () => {
    const svg = qr ?? barcode;
    if (!svg) return;
    // Through the shared seam, never a hand-rolled anchor: it is the one place that appends the
    // anchor and defers the revoke, which Firefox needs for the file to arrive at all (issue #646).
    download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(itemName)}-${qr ? 'qr' : 'barcode'}.svg`);
  };

  return (
    <Modal open={open} onClose={onClose} title="Item label" description={itemName}>
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-2 text-xs font-medium text-muted-foreground">
          <span id={symbologyLabelId}>Code</span>
          <Select
            value={symbology}
            onChange={(value) => setSymbology(value as LabelSymbology)}
            className="w-auto"
            data-testid="qr-symbology"
            aria-labelledby={symbologyLabelId}
            options={LABEL_SYMBOLOGY_OPTIONS.filter((o) => o.value !== 'none').map((o) => ({
              value: o.value,
              label: o.label,
            }))}
          />
        </div>

        <div className="flex flex-col items-center gap-3">
          {qr ? (
            <div
              className="w-fit rounded-xl bg-white p-3 shadow-inner [&_svg]:size-48"
              // The SVG is generated locally from our own encoder — no external input.
              dangerouslySetInnerHTML={{ __html: qr }}
              data-testid="item-qr"
            />
          ) : null}
          {qrTooLong ? (
            <p
              role="alert"
              data-testid="item-qr-too-long"
              className="max-w-xs rounded-lg border border-border bg-muted/40 px-3 py-2 text-center text-sm text-muted-foreground"
            >
              {t('inventory.qr.tooLong')}
            </p>
          ) : null}
          {barcode ? (
            <div
              className="w-full max-w-xs rounded-lg bg-white p-3 [&_svg]:h-16 [&_svg]:w-full"
              // The SVG is generated locally from our own encoder — no external input.
              dangerouslySetInnerHTML={{ __html: barcode }}
              data-testid="item-barcode"
            />
          ) : null}
          {barcodeShortened ? (
            <p
              role="alert"
              data-testid="item-barcode-shortened"
              className="max-w-xs rounded-lg border border-border bg-muted/40 px-3 py-2 text-center text-sm text-muted-foreground"
            >
              {t('inventory.labels.barcodeShortenedItem')}
            </p>
          ) : null}
        </div>

        {/* Shown as well as printed, so the code can be read straight off the screen — the
            fastest way to identify an item whose label has already been damaged. */}
        {printedShortCode ? (
          <p
            className="text-center font-mono text-sm tracking-widest text-foreground"
            data-testid="item-short-code"
          >
            {printedShortCode}
          </p>
        ) : null}

        {qr ? (
          <p className="break-all text-center text-xs text-muted-foreground" data-testid="item-qr-url">
            {url}
          </p>
        ) : null}

        {/* NFC write status — announced to assistive tech as it changes (arming, success, error).
            Only present once a write has been started, so the dialog stays uncluttered otherwise. */}
        {nfcWritable && nfcStatus !== 'idle' ? (
          <div
            role="status"
            data-testid="nfc-write-status"
            className={`flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm ${
              nfcStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {nfcStatus === 'writing' ? (
              <>
                <NfcIcon className="size-4 animate-pulse" aria-hidden />
                <span>Hold a blank tag flat against your phone…</span>
                <Button variant="ghost" size="sm" onClick={cancel} data-testid="nfc-write-cancel">
                  <CloseIcon /> Cancel
                </Button>
              </>
            ) : nfcStatus === 'success' ? (
              <>
                <SuccessIcon className="size-4 text-glyph-success" aria-hidden />
                <span>Saved to the tag — tap it any time to open this item.</span>
              </>
            ) : (
              <span>{nfcError}</span>
            )}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {nfcWritable ? (
            <Button
              variant="outline"
              onClick={() => write(url)}
              disabled={nfcStatus === 'writing'}
              data-testid="nfc-write"
            >
              <NfcIcon />
              {nfcStatus === 'error' ? 'Try again' : 'Write to tag'}
            </Button>
          ) : null}
          {/* Nothing encoded (e.g. a deep-link too long to fit a QR) means there is nothing to
              download or print — leaving these live would just make them look broken. */}
          <Button variant="outline" onClick={downloadSvg} disabled={!hasCode}>
            <DownloadIcon />
            Download SVG
          </Button>
          <Button onClick={print} disabled={!hasCode}>
            <PrintIcon />
            Print label
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The widest this dialog prints a code, in mm — the `max-width` its print stylesheet
 * applies (built from this constant, so the two cannot drift). It is what a Code 128's
 * module width is measured against when deciding whether the MPN will still be readable.
 */
const PRINTED_BARCODE_MM = 74;

const SINGLE_CODE_SYMBOLOGIES = new Set<LabelSymbology>(['qr', 'barcode', 'both']);

/** Coerce a stored symbology to one a single-code dialog can show, defaulting to QR. */
function seedSymbology(value: unknown): LabelSymbology {
  return SINGLE_CODE_SYMBOLOGIES.has(value as LabelSymbology) ? (value as LabelSymbology) : 'qr';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}
