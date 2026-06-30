import type { LabelCell } from '../labels/label-sheet';

/**
 * On-screen preview of a single resolved {@link LabelCell} (Phase 73). Renders the
 * same QR/barcode SVGs and text lines the printed sheet uses (both come from the pure
 * `toLabelCells`), so the preview can never diverge from the output. The SVGs carry
 * their own white quiet-zone background (so a code stays scannable regardless of the
 * app theme); everything else uses design tokens.
 */
export function LabelCellPreview({ cell }: { cell: LabelCell }) {
  return (
    <div
      data-testid="label-cell"
      className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-card p-3 text-center"
    >
      {cell.qrSvg ? (
        <div
          className="[&_svg]:size-24"
          // SVG is generated locally from our own encoder — no external input.
          dangerouslySetInnerHTML={{ __html: cell.qrSvg }}
        />
      ) : null}
      {cell.barcodeSvg ? (
        <div
          className="w-full [&_svg]:h-12 [&_svg]:w-full"
          // SVG is generated locally from our own encoder — no external input.
          dangerouslySetInnerHTML={{ __html: cell.barcodeSvg }}
        />
      ) : null}
      {cell.lines.map((line, i) => (
        <span
          key={i}
          className={
            i === 0
              ? 'line-clamp-2 break-words text-xs font-medium text-foreground'
              : 'break-words text-[11px] text-muted-foreground'
          }
        >
          {line}
        </span>
      ))}
    </div>
  );
}
