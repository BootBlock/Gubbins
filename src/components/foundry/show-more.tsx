import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface ShowMoreProps {
  /** How many rows the list is currently rendering. */
  readonly shown: number;
  /** How many rows the list holds in total. */
  readonly total: number;
  /**
   * A localised plural noun for the rows — "categories", "items". It names the list in the
   * summary and in each control's accessible name, so several of these on one screen are told
   * apart by a screen reader rather than all reading "Show more".
   */
  readonly label: string;
  /** Whether the list is revealed past its initial slice, so collapsing is offered. */
  readonly expanded: boolean;
  readonly onShowMore: () => void;
  readonly onShowLess: () => void;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/**
 * Foundry ShowMore (issue #609) — the honest footer for a list that renders the head of a larger
 * set: it states how many of how many are on screen, and offers the controls to reach the rest or
 * collapse back. Presentational and controlled; pair it with {@link ./use-progressive-reveal} for
 * the counting.
 *
 * A slice with nothing beneath it reads as the whole set — a valuation breakdown showing 12 of 40
 * categories is read as *these are the categories that hold value*. That is what this footer
 * exists to prevent, so it renders whenever anything is held back (and while expanded, to offer
 * the way back), and `null` only when the list really is complete and unexpanded.
 *
 * Accessibility: the summary is a polite live region, so revealing more announces the new count;
 * each control's accessible name carries the list's noun after its visible text (WCAG 2.5.3
 * label-in-name is preserved — the visible label stays the start of the accessible name).
 */
export function ShowMore({
  shown,
  total,
  label,
  expanded,
  onShowMore,
  onShowLess,
  className,
  'data-testid': testId,
}: ShowMoreProps) {
  const t = useT();
  const hasMore = shown < total;

  // Nothing held back and nothing to collapse — the list is already the whole set.
  if (!hasMore && !expanded) return null;

  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1', className)}
      data-testid={testId}
    >
      <p
        className="text-xs tabular-nums text-muted-foreground"
        role="status"
        aria-live="polite"
        data-testid={testId ? `${testId}-summary` : undefined}
      >
        {t('showMore.summary', { vars: { shown, total, label } })}
      </p>

      <div className="flex items-center gap-2">
        {expanded ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onShowLess}
            data-testid={testId ? `${testId}-less` : undefined}
          >
            {/* One flex child, so the visually-hidden noun can't open a gap in the label. */}
            <span>
              {t('showMore.fewer')}
              <span className="sr-only"> {label}</span>
            </span>
          </Button>
        ) : null}
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onShowMore}
            data-testid={testId ? `${testId}-more` : undefined}
          >
            <span>
              {t('showMore.more')}
              <span className="sr-only"> {label}</span>
            </span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
