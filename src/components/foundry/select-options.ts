/**
 * {@link Select}'s list maths — a pure seam, kept out of the component file so the filtering
 * rules are unit-testable in isolation (and so the component module exports only components,
 * for fast-refresh). The same split as `autocomplete-filter.ts` / `pagination-window.ts`.
 *
 * The problem both halves serve only appears once a list stops being a handful of rows: a picker
 * fed the whole location hierarchy (deliberately read uncapped — a bin-level inventory plausibly
 * has thousands) can neither be *searched* nor *rendered* row-for-row. Windowing itself is not
 * here: it is `@tanstack/react-virtual`, the same virtualiser the location sidebar already
 * windows this hierarchy with.
 */
import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';

/** The subset of a {@link SelectOption} the filter needs — satisfied structurally. */
interface FilterableOption {
  readonly label: string;
  readonly kind?: 'action';
}

/**
 * Option count at or above which {@link Select} offers a filter box. The popover caps at 240px
 * — about eight rows — so this is roughly "the list is more than a screenful and a half", the
 * point at which finding a row means scrolling rather than looking.
 */
export const SELECT_FILTER_THRESHOLD = 12;

/**
 * Option count above which the list is *windowed* — only the rows near the viewport exist in
 * the DOM. Well clear of any list a person reads end to end, so ordinary pickers keep rendering
 * whole and behave exactly as they always have.
 */
export const SELECT_WINDOW_THRESHOLD = 100;

/** Estimated row height (px), matching an option's `px-2 py-1.5 text-sm` box; measured for real once rendered. */
export const SELECT_OPTION_HEIGHT = 32;

/**
 * Viewport height (px) assumed before the list box has been measured — and the floor applied to
 * every later measurement. A window sized from a zero-height port holds no rows at all, so a
 * popover measured mid-layout (or in any environment that computes no layout) would render
 * *nothing* rather than a short list. Mirrors the popover's own cap in `use-anchored-popover.ts`.
 */
export const SELECT_FALLBACK_VIEWPORT = 240;

/** Rows rendered beyond each edge of the viewport, so a scroll reveals filled rows, not gaps. */
export const SELECT_WINDOW_OVERSCAN = 6;

/**
 * The options a filter query leaves visible, in the caller's original order.
 *
 * Order is *preserved* rather than ranked: a Select's list is frequently structural — the
 * location picker's rows are indented tree paths — so re-ordering prefix matches above
 * substring ones (which is right for {@link Autocomplete}, whose list is a flat catalogue of
 * names) would scramble the hierarchy the labels are drawing. Matching itself is the app-wide
 * picker model from `lib/text-terms`: whitespace splits the query into terms that must *all*
 * appear, case-insensitively.
 *
 * Command rows (`kind: 'action'`, e.g. "＋ New location…") always survive the filter. They are
 * not one of the values being searched, and a query that matches nothing is exactly when
 * "create it, then" is the thing the user wants.
 */
export function filterSelectOptions<T extends FilterableOption>(
  options: readonly T[],
  query: string,
): readonly T[] {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return options;
  return options.filter((option) => option.kind === 'action' || includesAllTerms(option.label, terms));
}

/**
 * Where the trailing run of command rows starts — i.e. the number of leading *ordinary* options.
 *
 * Only the ordinary options are windowed. Command rows are pinned to the end of the list by every
 * caller and are few, so they always render: keeping them out of the virtualised range spares the
 * measurement a row whose divider and extra padding make it a different height from every other.
 */
export function trailingActionStart(options: readonly FilterableOption[]): number {
  let index = options.length;
  while (index > 0 && options[index - 1]?.kind === 'action') index -= 1;
  return index;
}
