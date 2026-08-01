/**
 * {@link Select}'s list maths — a pure seam, kept out of the component file so the filtering
 * and windowing rules are unit-testable in isolation (and so the component module exports only
 * components, for fast-refresh). The same split as `autocomplete-filter.ts` / `pagination-window.ts`.
 *
 * Two problems live here, both of which only appear once a list stops being a handful of rows:
 * a picker fed the whole location hierarchy (deliberately read uncapped — a bin-level inventory
 * plausibly has thousands) can neither be *searched* nor *rendered* row-for-row.
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

/** Fallback row height (px) matching an option's `px-2 py-1.5 text-sm` box; remeasured live. */
export const SELECT_OPTION_HEIGHT = 32;

/** Fallback viewport height (px) when the list box hasn't been measured — mirrors the popover cap. */
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
 * Windowing assumes every row it stands a spacer in for is the same height, and a command row
 * is not (it carries a divider and extra padding). They are pinned to the end of the list by
 * every caller, so the windowed region is the ordinary options and the few command rows after
 * them always render.
 */
export function trailingActionStart(options: readonly FilterableOption[]): number {
  let index = options.length;
  while (index > 0 && options[index - 1]?.kind === 'action') index -= 1;
  return index;
}

/** The slice of a long option list that needs to exist in the DOM, plus the spacers standing in
 *  for the rest so the scrollbar still measures the whole list. */
export interface OptionWindow {
  /** First option index to render (inclusive). */
  readonly start: number;
  /** One past the last option index to render. */
  readonly end: number;
  /** Height (px) of the spacer standing in for the options before {@link start}. */
  readonly padTop: number;
  /** Height (px) of the spacer standing in for the options after {@link end}. */
  readonly padBottom: number;
}

/**
 * Which rows of a `count`-row list are worth rendering for a listbox scrolled to `scrollTop`
 * with `viewportHeight` of visible space, padded by {@link SELECT_WINDOW_OVERSCAN} rows either
 * side. `padTop + (end - start) * rowHeight + padBottom` always equals the full list height, so
 * the scrollbar reports the real size and every row stays reachable by scrolling — this windows
 * the list, it does not cap it.
 *
 * A non-positive `viewportHeight` or `rowHeight` (nothing laid out yet — a first render, or a
 * DOM without layout under test) falls back to the nominal figures rather than collapsing the
 * window to nothing.
 */
export function selectWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = SELECT_OPTION_HEIGHT,
): OptionWindow {
  const rows = Math.max(0, Math.trunc(count));
  const height = rowHeight > 0 ? rowHeight : SELECT_OPTION_HEIGHT;
  const viewport = viewportHeight > 0 ? viewportHeight : SELECT_FALLBACK_VIEWPORT;
  const firstVisible = Math.floor(Math.max(0, scrollTop) / height);
  const start = Math.max(0, Math.min(Math.max(0, rows - 1), firstVisible - SELECT_WINDOW_OVERSCAN));
  const end = Math.min(rows, start + Math.ceil(viewport / height) + SELECT_WINDOW_OVERSCAN * 2);
  return { start, end, padTop: start * height, padBottom: (rows - end) * height };
}

/**
 * The `scrollTop` that brings row `index` into view, moving as little as possible — the
 * `block: 'nearest'` behaviour `scrollIntoView` gives an element that actually exists, computed
 * arithmetically for a row that may currently be outside the window and therefore not in the DOM.
 */
export function scrollTopForRow(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = SELECT_OPTION_HEIGHT,
): number {
  const height = rowHeight > 0 ? rowHeight : SELECT_OPTION_HEIGHT;
  const viewport = viewportHeight > 0 ? viewportHeight : SELECT_FALLBACK_VIEWPORT;
  const top = Math.max(0, index) * height;
  if (top < scrollTop) return top;
  const bottom = top + height;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return scrollTop;
}
