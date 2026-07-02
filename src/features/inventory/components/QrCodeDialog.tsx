import { useEffect, useId, useMemo, useState } from 'react';
import { Button, Modal, Select } from '@/components/foundry';
import { DownloadIcon, PrintIcon } from '@/components/icons';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import { qrSvg } from '@/features/scanner/qr-code';
import { code128Svg } from '../labels/code128';
import { LABEL_SYMBOLOGY_OPTIONS, labelBarcodeValue, type LabelSymbology } from '../labels/label-template';
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
  const defaultSymbology = usePreferencesStore((s) => s.labelTemplate.symbology);
  // Seed from the saved default, coercing 'none' (meaningless for a single-code dialog)
  // and any stale/garbage persisted value to QR.
  const [symbology, setSymbology] = useState<LabelSymbology>(() => seedSymbology(defaultSymbology));
  const symbologyLabelId = useId();
  useEffect(() => {
    if (open) setSymbology(seedSymbology(defaultSymbology));
  }, [open, defaultSymbology]);

  const baseUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    try {
      return new URL(import.meta.env.BASE_URL, window.location.origin).href;
    } catch {
      return '#';
    }
  }, []);

  const url = useMemo(() => buildItemQrUrl(itemId, baseUrl), [itemId, baseUrl]);
  const barcodeValue = useMemo(() => labelBarcodeValue({ id: itemId, mpn: itemMpn }), [itemId, itemMpn]);

  const showQr = symbology === 'qr' || symbology === 'both';
  const showBarcode = symbology === 'barcode' || symbology === 'both';

  const qr = useMemo(() => (showQr ? qrSvg(url, { scale: 8, margin: 4 }) : null), [showQr, url]);
  const barcode = useMemo(() => {
    if (!showBarcode) return null;
    try {
      return code128Svg(barcodeValue, { scale: 2, height: 64, margin: 10, showText: true });
    } catch {
      return null;
    }
  }, [showBarcode, barcodeValue]);

  const print = () => {
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;
    w.document.write(
      `<!doctype html><title>${escapeHtml(itemName)} — label</title>` +
        `<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}` +
        `h1{font-size:16px;margin:0 0 12px}svg{max-width:280px}` +
        `.qr svg{width:240px;height:240px}.bc{margin-top:12px}.bc svg{height:80px}` +
        `p{font-size:11px;color:#555;word-break:break-all;margin-top:12px}</style>` +
        `<h1>${escapeHtml(itemName)}</h1>` +
        (qr ? `<div class="qr">${qr}</div>` : '') +
        (barcode ? `<div class="bc">${barcode}</div>` : '') +
        (qr ? `<p>${escapeHtml(url)}</p>` : ''),
    );
    w.document.close();
    w.focus();
    w.print();
  };

  const download = () => {
    const svg = qr ?? barcode;
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${slug(itemName)}-${qr ? 'qr' : 'barcode'}.svg`;
    a.click();
    URL.revokeObjectURL(href);
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
          {barcode ? (
            <div
              className="w-full max-w-xs rounded-lg bg-white p-3 [&_svg]:h-16 [&_svg]:w-full"
              // The SVG is generated locally from our own encoder — no external input.
              dangerouslySetInnerHTML={{ __html: barcode }}
              data-testid="item-barcode"
            />
          ) : null}
        </div>

        {qr ? (
          <p className="break-all text-center text-xs text-muted-foreground" data-testid="item-qr-url">
            {url}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={download}>
            <DownloadIcon />
            Download SVG
          </Button>
          <Button onClick={print}>
            <PrintIcon />
            Print label
          </Button>
        </div>
      </div>
    </Modal>
  );
}

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
