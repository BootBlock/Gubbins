import { cn } from '@/lib/utils';
import type { LabelCell } from '../labels/label-sheet';

/**
 * On-screen preview of a single resolved {@link LabelCell} (Phase 73). Renders the
 * same QR/barcode SVGs and text lines the printed sheet uses (both come from the pure
 * `toLabelCells`), so the preview can never diverge from the output. The SVGs carry
 * their own white quiet-zone background (so a code stays scannable regardless of the
 * app theme); everything else uses design tokens.
 *
 * When a physical `size` (die-cut mode) is supplied the card takes that label's exact
 * aspect ratio and the code shrinks to fit its height, so the preview shows the true
 * label shape a thermal printer would produce.
 *
 * The name's line clamp below is part of that promise rather than preview-only tidying: both
 * print stylesheets clamp the name to the same `LABEL_NAME_MAX_LINES` count, so a long name
 * that reads as truncated here prints truncated too (issue #334).
 */
export function LabelCellPreview({
  cell,
  size,
}: {
  cell: LabelCell;
  /** Physical label size (mm) — constrains the preview to that aspect ratio. */
  size?: { readonly widthMm: number; readonly heightMm: number };
}) {
  const physical = size != null;
  return (
    <div
      data-testid="label-cell"
      className={cn(
        'flex flex-col items-center rounded-lg border border-border/60 bg-card p-3 text-center',
        physical ? 'mx-auto w-full max-w-[11rem] justify-center gap-1 overflow-hidden' : 'gap-2',
      )}
      style={physical ? { aspectRatio: `${size.widthMm} / ${size.heightMm}` } : undefined}
    >
      {cell.qrSvg ? (
        <div
          className={
            physical
              ? 'flex min-h-0 flex-1 items-center [&_svg]:h-full [&_svg]:max-h-full [&_svg]:w-auto'
              : '[&_svg]:size-24'
          }
          // SVG is generated locally from our own encoder — no external input.
          dangerouslySetInnerHTML={{ __html: cell.qrSvg }}
        />
      ) : null}
      {cell.barcodeSvg ? (
        <div
          className={cn('w-full [&_svg]:w-full', physical ? '[&_svg]:h-8' : '[&_svg]:h-12')}
          // SVG is generated locally from our own encoder — no external input.
          dangerouslySetInnerHTML={{ __html: cell.barcodeSvg }}
        />
      ) : null}
      {cell.lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'break-words',
            // Tailwind only emits utilities it finds as literal class names, so this cannot be
            // built from `LABEL_NAME_MAX_LINES`; a guard test in `label-sheet.test.ts` pins the
            // literal to that constant instead, and fails if either side moves.
            i === 0 ? 'line-clamp-2 font-medium text-foreground' : 'text-muted-foreground',
            // Inside the fixed-aspect card the code shrinks for the text, never the other way
            // round — matching the die-cut stylesheet, where a shrunk name loses its ellipsis
            // to the label's clipping (#334).
            physical ? 'max-w-full shrink-0 text-[10px] leading-tight' : i === 0 ? 'text-xs' : 'text-[11px]',
          )}
        >
          {line}
        </span>
      ))}
    </div>
  );
}
