/**
 * The Settings dialog's search results (issue #133) — what the rail and panel are replaced
 * with while the filter box has something in it.
 *
 * Every tab's sections are rendered at once, in rail order, each group captioned with the tab
 * it normally lives behind; the {@link ./settings-search} seam then takes out the rows that
 * don't match and hides the sections and groups left with nothing. The controls are the real
 * ones, so a setting found here can be changed without first navigating to its tab.
 */
import { useId, useMemo, type ReactNode } from 'react';
import { LiveRegion } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { splitSearchTerms } from '@/lib/text-terms';
import { cn } from '@/lib/utils';
import { SettingsSearchTermsContext, useSettingsSearchContainer } from './settings-search';

/**
 * One tab's worth of sections, captioned with the tab it normally lives behind — so a match
 * still says *where* the setting is, and the rail's grouping isn't lost just because the
 * results span every tab. Hides itself when that tab has no matches.
 */
export function SettingsSearchGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const search = useSettingsSearchContainer(label);
  const captionId = useId();
  return (
    <section aria-labelledby={captionId} className={cn('space-y-4', search.hidden && 'hidden')}>
      <h2 id={captionId} className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
      {search.wrap(children)}
    </section>
  );
}

/**
 * The results view: establishes the query for everything inside it, and leads with the match
 * count (announced, and shown — a filter that silently empties the panel is worse than one
 * that says why).
 */
export function SettingsSearchResults({
  query,
  children,
}: {
  readonly query: string;
  readonly children: ReactNode;
}) {
  const terms = useMemo(() => splitSearchTerms(query), [query]);
  return (
    <SettingsSearchTermsContext.Provider value={terms}>
      <SettingsSearchResultsBody query={query}>{children}</SettingsSearchResultsBody>
    </SettingsSearchTermsContext.Provider>
  );
}

/** The body of {@link SettingsSearchResults}, split out so it can read the terms it provides. */
function SettingsSearchResultsBody({
  query,
  children,
}: {
  readonly query: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  // The outermost scope carries no label of its own: a query must be answered by a real tab,
  // section or row, never by the dialog simply being Settings.
  const search = useSettingsSearchContainer('');

  return (
    <div className="space-y-5" data-testid="settings-search-results">
      {/* Always mounted, only its text changing — a region inserted at the moment it has
          something to say is frequently never announced (see {@link LiveRegion}). */}
      <LiveRegion className="px-1 text-xs text-muted-foreground" data-testid="settings-search-count">
        {t('settings.search.results', { vars: { count: search.count } })}
      </LiveRegion>

      {search.wrap(children)}

      {search.count === 0 ? (
        <div
          className="rounded-2xl border border-dashed border-border p-8 text-center"
          data-testid="settings-search-empty"
        >
          <p className="text-sm font-medium">
            {t('settings.search.empty.heading', { vars: { query: query.trim() } })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('settings.search.empty.body')}</p>
        </div>
      ) : null}
    </div>
  );
}
