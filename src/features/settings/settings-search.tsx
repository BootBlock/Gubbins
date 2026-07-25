/**
 * Settings search — the cross-tab type-to-filter seam behind the Settings dialog (issue #133).
 *
 * Settings is a ten-tab {@link RailModal} carrying well over sixty controls, and only the
 * active tab's panel is mounted — so "which tab holds *Pure black (OLED)*?" meant opening each
 * one in turn. Typing in the dialog's filter box switches the panel to a single scrolling view
 * of **every** tab's sections, with the rows that don't match taken out; the controls shown are
 * the real ones, so a setting can be changed straight from the results.
 *
 * Matching is the shared free-text model (`lib/text-terms`): whitespace splits the query into
 * terms that must *all* appear, case-insensitively, somewhere in a row's label, description or
 * rich hint — or in the labels of the section and tab it sits under. So "scanner beep" finds
 * the Beep-on-scan row (the term "scanner" coming from its section), and a query answered by a
 * section or tab label alone — "hotkeys" — keeps everything inside it.
 *
 * **Rows decide for themselves; containers learn what survived.** There is deliberately no
 * index of the dialog's contents to match against: an index would have to be kept in step with
 * the JSX by hand, and a good half of the rows are not in the dialog's JSX at all (the reminder
 * rows come from `ReminderSettings`, every hotkey row from `HotkeySettings`, the erase row from
 * `DangerZone`). Instead each {@link SettingRow} matches itself and reports the verdict to the
 * nearest counting scope; a section or tab group left with nothing hides itself, and the same
 * counts give the "N settings match" announcement. Nothing is reported while the box is empty,
 * so an unfiltered Settings render costs exactly what it did before.
 *
 * This module is the seam itself; the view that uses it — the results panel and its per-tab
 * groups — is {@link ./SettingsSearchResults}.
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { includesAllTerms } from '@/lib/text-terms';

/** No terms at all — the dialog's ordinary, unfiltered state, where every row shows. */
const NO_TERMS: readonly string[] = [];

/**
 * The terms every row below matches against. Provided by the results view (the only place a
 * query exists); everywhere else it defaults to none, which is what leaves the ordinary
 * Settings panels unfiltered without their having to know this seam exists.
 */
export const SettingsSearchTermsContext = createContext<readonly string[]>(NO_TERMS);

/**
 * The labels of the containers a row sits inside (its tab group, then its section), and
 * whether the query is already satisfied by those labels alone — in which case everything
 * inside them shows without each row having to match on its own.
 */
export interface SettingsSearchScope {
  /** The container labels, outermost first, joined for substring matching. */
  readonly text: string;
  /** True when every term is already found in {@link text}. */
  readonly matched: boolean;
}

const ROOT_SCOPE: SettingsSearchScope = { text: '', matched: false };
const ScopeContext = createContext<SettingsSearchScope>(ROOT_SCOPE);

/** How a descendant reports the number of visible rows it accounts for to its container. */
type ReportCount = (id: string, count: number) => void;
const CountContext = createContext<ReportCount | null>(null);

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/** The active search terms; empty when the dialog is unfiltered. */
export function useSettingsSearchTerms(): readonly string[] {
  return useContext(SettingsSearchTermsContext);
}

/**
 * True when every term is found across a row's own text plus its containers' labels. Pure, so
 * the matching rules can be exercised without rendering the dialog. Blank parts are dropped so
 * a row without a hint doesn't match on the gap it leaves.
 */
export function matchesSettingSearch(
  terms: readonly string[],
  scope: SettingsSearchScope,
  parts: readonly (string | undefined)[],
): boolean {
  if (terms.length === 0 || scope.matched) return true;
  return includesAllTerms([scope.text, ...parts].filter(Boolean).join(' '), terms);
}

/** Report this node's visible-row count to the enclosing container, if there is one. */
function useReportMatchCount(count: number): void {
  const id = useId();
  const report = useContext(CountContext);
  useLayoutEffect(() => {
    if (report === null) return;
    report(id, count);
    return () => report(id, 0);
  }, [report, id, count]);
}

/**
 * Decide whether a settings row survives the current filter, and report the verdict to the
 * enclosing section. Returns `true` when the row should render — always so while the filter
 * box is empty.
 */
export function useSettingSearchMatch(parts: readonly (string | undefined)[]): boolean {
  const terms = useSettingsSearchTerms();
  const scope = useContext(ScopeContext);
  const matched = matchesSettingSearch(terms, scope, parts);
  useReportMatchCount(terms.length > 0 && matched ? 1 : 0);
  return matched;
}

/** What a settings container (a section, or a tab group in the results view) gets back. */
export interface SettingsSearchContainer {
  /** How many rows inside are currently showing — 0 while the dialog is unfiltered. */
  readonly count: number;
  /** True when the filter is active and nothing inside this container survived it. */
  readonly hidden: boolean;
  /**
   * Wrap the container's children, so rows inside can match on its label and report back to
   * it. The children stay mounted even when {@link hidden} — they are what decides whether the
   * container has anything left to show, so hiding is a `display: none`, not an unmount.
   */
  readonly wrap: (children: ReactNode) => ReactNode;
}

/**
 * Own a counting scope for a settings container labelled `label`. Extends the ancestor-label
 * chain for the rows inside, tallies how many of them survive the filter, and reports that
 * total on up — so scopes nest row → section → tab group → dialog.
 */
export function useSettingsSearchContainer(label: string): SettingsSearchContainer {
  const terms = useSettingsSearchTerms();
  const parent = useContext(ScopeContext);
  const scope = useMemo<SettingsSearchScope>(() => {
    const text = parent.text === '' ? label : `${parent.text} ${label}`;
    return {
      text,
      matched: parent.matched || (terms.length > 0 && includesAllTerms(text, terms)),
    };
  }, [parent, label, terms]);

  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(NO_COUNTS);
  const register = useCallback<ReportCount>((id, next) => {
    setCounts((prev) => {
      if ((prev.get(id) ?? 0) === next) return prev;
      const updated = new Map(prev);
      if (next === 0) updated.delete(id);
      else updated.set(id, next);
      return updated;
    });
  }, []);

  let rows = 0;
  for (const n of counts.values()) rows += n;
  // A container matched on its own label counts as one hit even when it holds no rows at all —
  // "Card fields" is a reorderable picker rather than a row list, and would otherwise be
  // filtered out of the very search its title answers.
  const count = rows > 0 ? rows : scope.matched ? 1 : 0;
  useReportMatchCount(terms.length > 0 ? count : 0);

  const wrap = useCallback(
    (children: ReactNode) => (
      <ScopeContext.Provider value={scope}>
        <CountContext.Provider value={register}>{children}</CountContext.Provider>
      </ScopeContext.Provider>
    ),
    [scope, register],
  );

  return { count, hidden: terms.length > 0 && count === 0, wrap };
}
