import { useEffect, useRef } from 'react';
import { useT } from '@/features/i18n';
import { Button } from './button';
import { LiveRegion } from './live-region';

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
 * Accessibility: the summary is a `LiveRegion`, so revealing more announces the new count;
 * each control names its list ("Show more: categories") through its own catalog key rather than a
 * hidden suffix, so a language that would not simply concatenate the two still reads as a phrase.
 * WCAG 2.5.3 label-in-name holds in every catalog because the visible label opens that key.
 */
export function ShowMore({
  shown,
  total,
  label,
  expanded,
  onShowMore,
  onShowLess,
  'data-testid': testId,
}: ShowMoreProps) {
  const t = useT();
  const hasMore = shown < total;
  const lessRef = useRef<HTMLButtonElement>(null);
  const focusAfterReveal = useRef(false);

  // The click that reveals the last chunk unmounts the control it came from, and focus with it
  // falls to `<body>` — dropping a keyboard user at the top of the document at exactly the moment
  // they asked to see the rest. Hand focus to the collapse control, which is always present by
  // then (revealing anything sets `expanded`). The flag is cleared on the first render after any
  // click, so only the click that actually ended the list moves focus.
  useEffect(() => {
    if (!focusAfterReveal.current) return;
    focusAfterReveal.current = false;
    if (!hasMore) lessRef.current?.focus();
  });

  // Nothing held back and nothing to collapse — the list is already the whole set.
  if (!hasMore && !expanded) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1" data-testid={testId}>
      <LiveRegion
        className="text-xs tabular-nums text-muted-foreground"
        data-testid={testId ? `${testId}-summary` : undefined}
      >
        {t('showMore.summary', { vars: { shown, total, label } })}
      </LiveRegion>

      <div className="flex items-center gap-2">
        {expanded ? (
          <Button
            ref={lessRef}
            variant="ghost"
            size="sm"
            onClick={onShowLess}
            aria-label={t('showMore.fewerLabel', { vars: { label } })}
            data-testid={testId ? `${testId}-less` : undefined}
          >
            {t('showMore.fewer')}
          </Button>
        ) : null}
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => {
              // Only hand focus on if this control actually held it — a mouse user who clicked
              // without focusing shouldn't have the focus ring jump somewhere new.
              focusAfterReveal.current = event.currentTarget === document.activeElement;
              onShowMore();
            }}
            aria-label={t('showMore.moreLabel', { vars: { label } })}
            data-testid={testId ? `${testId}-more` : undefined}
          >
            {t('showMore.more')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
