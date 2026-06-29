import { useMemo } from 'react';
import { Button, Modal } from '@/components/foundry';
import { PrintIcon } from '@/components/icons';
import {
  MAX_LABELS,
  buildLabelSheetHtml,
  toLabelCells,
  type LabelItem,
} from '../qr-label-sheet';

/**
 * Batch QR label-sheet preview & print (spec §6 "Printable QR generation", Phase 49).
 *
 * Shows the QR labels for the selected items as a grid preview, then prints them as
 * a single A4 sheet via the pure {@link buildLabelSheetHtml} (opened in a fresh
 * window, mirroring {@link QrCodeDialog}'s single-label print). The preview and the
 * printed sheet share {@link toLabelCells}, so what you see is what prints.
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
  const baseUrl = useMemo(() => {
    if (typeof window === 'undefined') return '#';
    try {
      return new URL(import.meta.env.BASE_URL, window.location.origin).href;
    } catch {
      return '#';
    }
  }, []);

  const cells = useMemo(() => toLabelCells(items, baseUrl), [items, baseUrl]);
  const truncated = items.length > MAX_LABELS;

  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    w.document.write(buildLabelSheetHtml(items, baseUrl));
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Print QR labels"
      description={`${cells.length} label${cells.length === 1 ? '' : 's'}`}
    >
      <div className="space-y-4">
        {truncated ? (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {items.length} items selected — printing the first {MAX_LABELS}.
          </p>
        ) : null}

        {cells.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No items selected.</p>
        ) : (
          <div
            data-testid="label-sheet-preview"
            className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-3"
          >
            {cells.map((cell, i) => (
              <div
                // ids may repeat across a selection in theory; index keeps keys stable.
                key={`${cell.id}-${i}`}
                data-testid="label-cell"
                className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-white p-3 text-center"
              >
                <div
                  className="[&_svg]:size-24"
                  // SVG is generated locally from our own encoder — no external input.
                  dangerouslySetInnerHTML={{ __html: cell.svg }}
                />
                <span className="line-clamp-2 break-words text-xs font-medium text-slate-900">
                  {cell.name}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
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
