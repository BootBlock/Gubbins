import { Banner } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { PLAIN_PAPER_SHEET_ID, sheetLayoutSelection, type SheetLayout } from '../labels/label-template';
import type { LabelSizeValue } from './LabelSizeControls';

/**
 * The print-dialog notice a die-cut *sheet* layout carries (issue #514).
 *
 * A named stock layout is tiled to the packet's published geometry to a hundredth of a
 * millimetre, and the printed document says so in its own `@page` rule — but the browser's
 * print dialog gets the last word. A scale other than 100%, or a margin mode that overrides
 * the document's margins, shifts and shrinks the whole grid, and the drift compounds down a
 * column until labels straddle the die-cuts. The failure is quiet: the preview thumbnail
 * looks plausible, and the sheet of stickers is spoiled before anyone notices.
 *
 * The sibling of `DieCutPrinterNotice`, and deliberately the same shape: an exact
 * geometry the app cannot enforce past the print dialog is worth saying out loud.
 *
 * Renders nothing for the plain-paper layout, which is cut by hand along the printed guides —
 * a scaled print there costs a sheet of paper and no registration. Every other layout gets the
 * notice, a hand-entered one included: stock the picker does not list is exactly the case that
 * cannot fall back on a preset being right.
 */
export function SheetPrinterNotice({
  size,
  layout,
  testId,
}: {
  readonly size: LabelSizeValue;
  readonly layout: SheetLayout;
  readonly testId: string;
}) {
  const t = useT();
  if (size.sizeMode !== 'sheet') return null;
  if (sheetLayoutSelection(layout) === PLAIN_PAPER_SHEET_ID) return null;
  return (
    <Banner tone="info" data-testid={testId}>
      {t('inventory.labels.sheetPrinterNotice')}
    </Banner>
  );
}
