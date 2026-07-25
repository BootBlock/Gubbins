import { Banner } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { dieCutSizeMm } from '../labels/label-sheet';
import type { LabelSizeValue } from './LabelSizeControls';

/**
 * The print-target notice a die-cut label size carries (issue #337).
 *
 * A die-cut page is sized in exact millimetres for a thermal / label printer, and the browser
 * gives no way to know which printer the user will pick. Send that page to an ordinary inkjet
 * and it is silently scaled to fill A4 — or cropped against the unprintable margin — so the
 * one honest thing is to say what the page is and what it needs, up front. Renders nothing in
 * A4-sheet mode, so the rule lives here rather than at each call site.
 *
 * The dimensions come from {@link dieCutSizeMm} — the same clamp the printed document sizes
 * its page with — so the notice can only ever name the size that will actually print.
 */
export function DieCutPrinterNotice({
  size,
  testId,
}: {
  readonly size: LabelSizeValue;
  readonly testId: string;
}) {
  const t = useT();
  if (size.sizeMode !== 'die-cut') return null;
  const { widthMm, heightMm } = dieCutSizeMm(size.widthMm, size.heightMm);
  return (
    <Banner tone="info" data-testid={testId}>
      {t('inventory.labels.dieCutPrinterNotice', { vars: { width: widthMm, height: heightMm } })}
    </Banner>
  );
}
