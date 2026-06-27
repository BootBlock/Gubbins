import { useMemo } from 'react';
import { Button, Modal } from '@/components/foundry';
import { DownloadIcon, PrintIcon } from '@/components/icons';
import { buildItemQrUrl } from '@/features/scanner/scan-payload';
import { qrSvg } from '@/features/scanner/qr-code';

/**
 * Printable QR code for an item (spec §5, Phase 6). Encodes the deep-link URL
 * `…/Gubbins/#/inventory?item=<id>` (the §2.4.3 lean hand-rolled encoder), so a
 * phone camera opens the app to the item and Gubbins' own scanner parses the id
 * back out. Offers print (a clean label window) and SVG download for label sheets.
 */
export function QrCodeDialog({
  open,
  onClose,
  itemId,
  itemName,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  itemName: string;
}) {
  const baseUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    try {
      return new URL(import.meta.env.BASE_URL, window.location.origin).href;
    } catch {
      return '#';
    }
  }, []);

  const url = useMemo(() => buildItemQrUrl(itemId, baseUrl), [itemId, baseUrl]);
  const svg = useMemo(() => qrSvg(url, { scale: 8, margin: 4 }), [url]);

  const print = () => {
    const w = window.open('', '_blank', 'width=420,height=520');
    if (!w) return;
    w.document.write(
      `<!doctype html><title>${escapeHtml(itemName)} — QR</title>` +
        `<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}` +
        `h1{font-size:16px;margin:0 0 12px}svg{width:240px;height:240px}` +
        `p{font-size:11px;color:#555;word-break:break-all;margin-top:12px}</style>` +
        `<h1>${escapeHtml(itemName)}</h1>${svg}<p>${escapeHtml(url)}</p>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  const download = () => {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${slug(itemName)}-qr.svg`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <Modal open={open} onClose={onClose} title="QR code" description={itemName}>
      <div className="space-y-4">
        <div
          className="mx-auto w-fit rounded-xl bg-white p-3 shadow-inner [&_svg]:size-48"
          // The SVG is generated locally from our own encoder — no external input.
          dangerouslySetInnerHTML={{ __html: svg }}
          data-testid="item-qr"
        />
        <p className="break-all text-center text-xs text-muted-foreground" data-testid="item-qr-url">
          {url}
        </p>
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}
