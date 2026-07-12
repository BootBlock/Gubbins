import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { Autocomplete } from './autocomplete';
import { Button } from './button';
import { pageWindow, type PageWindowItem } from './pagination-window';

export interface PaginationProps {
  /** The current page, 1-based. Clamped into range for rendering. */
  readonly page: number;
  /** Total number of pages. The control renders nothing when this is ≤ 1 (nothing to page). */
  readonly pageCount: number;
  /** Called with the chosen page (1-based) when the user navigates. */
  readonly onPageChange: (page: number) => void;
  /** The current page size (items per page). */
  readonly pageSize: number;
  /** Called with the chosen page size (already clamped to `[minPageSize, maxPageSize]`). */
  readonly onPageSizeChange: (size: number) => void;
  /** Suggested sizes offered by the editable size picker. */
  readonly pageSizeOptions: readonly number[];
  /** Inclusive lower bound for a typed page size. */
  readonly minPageSize: number;
  /** Inclusive upper bound for a typed page size. */
  readonly maxPageSize: number;
  /**
   * Total item count, for the "{start}–{end} of {total}" summary. Omit to show a plain
   * "Page {page} of {pages}" instead (e.g. when the total isn't cheaply known).
   */
  readonly totalItems?: number;
  /** Pages either side of the current always shown (default 1). */
  readonly siblingCount?: number;
  /** Pages pinned at each end always shown (default 1). */
  readonly boundaryCount?: number;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/**
 * Foundry Pagination (issue #20) — the app-wide page control shown at the foot of a browse
 * list when it splits into more than one page. Presentational and controlled: the caller owns
 * the current page + page size and the data behind them; this renders the numbered page strip
 * (with collapsed `…` runs from the pure {@link pageWindow} seam), Previous/Next, and an
 * **editable** items-per-page picker (a real combobox — type any value in range, or pick a
 * preset). Fully tokenised and localised through the `t()` seam; nothing is hard-coded.
 *
 * Accessibility (WAI-ARIA APG pagination): a `<nav>` landmark names the control, each page
 * button carries `aria-label="Page N"` and the current one `aria-current="page"`, ellipses are
 * decorative (`aria-hidden`), and the summary is a polite live region so a page change is
 * announced. Renders `null` when there is nothing to paginate (`pageCount ≤ 1`).
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageSizeOptions,
  minPageSize,
  maxPageSize,
  totalItems,
  siblingCount = 1,
  boundaryCount = 1,
  className,
  'data-testid': testId,
}: PaginationProps) {
  const t = useT();

  // Nothing to page through — the control only earns its place with more than one page (spec).
  if (pageCount <= 1) return null;

  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const items = pageWindow(current, pageCount, { siblingCount, boundaryCount });

  // The item range this page covers, for the summary ("{start}–{end} of {total}"). Only shown
  // when the caller knows the total; otherwise a plain page-of-pages summary is used.
  const hasTotal = typeof totalItems === 'number' && Number.isFinite(totalItems);
  const start = hasTotal ? Math.min((current - 1) * pageSize + 1, totalItems!) : 0;
  const end = hasTotal ? Math.min(current * pageSize, totalItems!) : 0;
  const summary = hasTotal
    ? t('pagination.summary', { vars: { start, end, total: totalItems! } })
    : t('pagination.pageOf', { vars: { page: current, pages: pageCount } });

  return (
    <nav
      aria-label={t('pagination.nav')}
      data-testid={testId}
      className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3', className)}
    >
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        data-testid={testId ? `${testId}-summary` : undefined}
      >
        {summary}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <PageSizePicker
          value={pageSize}
          onChange={onPageSizeChange}
          options={pageSizeOptions}
          min={minPageSize}
          max={maxPageSize}
        />

        <ul className="flex items-center gap-1">
          <li>
            <Button
              variant="outline"
              size="sm"
              className="px-2"
              aria-label={t('pagination.previous')}
              disabled={current <= 1}
              onClick={() => onPageChange(current - 1)}
              data-testid={testId ? `${testId}-prev` : undefined}
            >
              <ChevronLeftIcon />
            </Button>
          </li>

          {items.map((item, index) => (
            <li key={`${item}-${index}`}>
              <PageCell item={item} current={current} onSelect={onPageChange} />
            </li>
          ))}

          <li>
            <Button
              variant="outline"
              size="sm"
              className="px-2"
              aria-label={t('pagination.next')}
              disabled={current >= pageCount}
              onClick={() => onPageChange(current + 1)}
              data-testid={testId ? `${testId}-next` : undefined}
            >
              <ChevronRightIcon />
            </Button>
          </li>
        </ul>
      </div>
    </nav>
  );
}

/** One page-strip cell: a page-number button, or a decorative ellipsis for a collapsed run. */
function PageCell({
  item,
  current,
  onSelect,
}: {
  readonly item: PageWindowItem;
  readonly current: number;
  readonly onSelect: (page: number) => void;
}) {
  const t = useT();
  if (item === 'ellipsis') {
    return (
      <span
        className="grid h-8 min-w-8 place-items-center px-1 text-sm text-muted-foreground"
        aria-hidden="true"
      >
        …
      </span>
    );
  }
  const active = item === current;
  return (
    <Button
      variant={active ? 'primary' : 'ghost'}
      size="sm"
      className="min-w-8 px-2 tabular-nums"
      // The current page states its role for assistive tech; the number alone is not enough.
      aria-label={
        active
          ? t('pagination.pageCurrent', { vars: { page: item } })
          : t('pagination.page', { vars: { page: item } })
      }
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(item)}
    >
      {item}
    </Button>
  );
}

/**
 * The editable items-per-page picker — a Foundry {@link Autocomplete} (a real combobox) so the
 * user can either pick a preset or type any value in range. The typed value is held as a local
 * draft and committed **clamped** on blur or when a preset is chosen, so a mid-typed "1" can't
 * momentarily reset the list to a one-row page.
 */
function PageSizePicker({
  value,
  onChange,
  options,
  min,
  max,
}: {
  readonly value: number;
  readonly onChange: (size: number) => void;
  readonly options: readonly number[];
  readonly min: number;
  readonly max: number;
}) {
  const t = useT();
  const labelId = useId();
  const [draft, setDraft] = useState(String(value));
  // Re-seed when the committed value changes elsewhere (Settings, or another list's picker).
  useEffect(() => setDraft(String(value)), [value]);

  const suggestions = options.map(String);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || raw.trim() === '') {
      setDraft(String(value)); // unparseable — snap back to the committed value
      return;
    }
    const next = clamp(parsed);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="whitespace-nowrap text-sm text-muted-foreground">
        {t('pagination.perPage')}
      </span>
      <Autocomplete
        value={draft}
        onChange={(next) => {
          setDraft(next);
          // Picking a preset (or typing one exactly) matches a suggestion — commit at once so a
          // mouse selection takes effect without waiting for blur. Free typing commits on blur.
          if (suggestions.includes(next.trim())) {
            const chosen = clamp(Number(next));
            if (chosen !== value) onChange(chosen);
          }
        }}
        onBlur={() => commit(draft)}
        suggestions={suggestions}
        aria-labelledby={labelId}
        inputMode="numeric"
        maxLength={3}
        className="h-8 w-20 text-sm"
        data-testid="pagination-page-size"
      />
    </div>
  );
}
