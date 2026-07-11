import { Link, useRouterState } from '@tanstack/react-router';
import { PageContainer, PageHeader, Surface, buttonVariants, MAIN_CONTENT_ID } from '@/components/foundry';
import { CompassIcon, HomeIcon, type LucideIcon } from '@/components/icons';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { suggestRoutes } from './route-suggestions';

/** A suggestable destination carrying the glyph the row renders alongside its label. */
interface SuggestCandidate {
  readonly to: string;
  readonly label: string;
  readonly Icon: LucideIcon;
}

/**
 * The 404 screen (issue #41) — the router's `defaultNotFoundComponent`.
 *
 * Replaces the bare "Not found" fallback with a fully-styled screen that sits inside the
 * standard app chrome (the {@link PageContainer} frame, the {@link PageHeader} with its global
 * navigation and command-palette search), tells the user plainly what happened, and — via a
 * fuzzy match of the path they typed against the real destinations — offers one-click routes to
 * the page they most likely meant. Everything routes through `t()` and design tokens, so it
 * themes, dark-modes and translates like any other screen.
 */
export function NotFoundScreen() {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const enabledFeatures = useEnabledFeatures();

  // Only suggest destinations the user can actually reach (Modular UI may hide some), and skip
  // the Dashboard — it already has its own prominent call-to-action below.
  const candidates: readonly SuggestCandidate[] = NAV_DESTINATIONS.filter(
    (d) => d.to !== '/' && enabledFeatures.has(d.feature),
  ).map((d) => ({ to: d.to, label: t(d.messageKey), Icon: d.Icon }));

  const suggestions = suggestRoutes(pathname, candidates);

  return (
    <PageContainer>
      <PageHeader icon={<CompassIcon />} title={t('notFound.title')} />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col outline-none">
        <Surface className="mx-auto w-full max-w-2xl p-7">
          <div className="flex items-start gap-4">
            <span
              className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary [&_svg]:size-6"
              aria-hidden
            >
              <CompassIcon />
            </span>
            <div className="min-w-0">
              <p
                aria-hidden
                className="text-4xl font-bold tracking-tight text-muted-foreground/60 tabular-nums"
              >
                404
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{t('notFound.heading')}</h2>
            </div>
          </div>

          <p className="mt-5 text-sm text-muted-foreground">{t('notFound.attempted')}</p>
          <p className="mt-2 overflow-x-auto rounded-lg bg-secondary/50 p-3 font-mono text-sm break-all text-foreground">
            {pathname}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">{t('notFound.explanation')}</p>

          {suggestions.length > 0 && (
            <section className="mt-6" aria-labelledby="not-found-suggestions">
              <h3 id="not-found-suggestions" className="text-sm font-semibold text-foreground">
                {t('notFound.suggestions.title')}
              </h3>
              <ul className="mt-3 flex flex-col gap-2">
                {suggestions.map(({ candidate }) => (
                  <li key={candidate.to}>
                    <Link
                      to={candidate.to}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-4 py-3 text-sm font-medium transition-colors duration-150 ease-emphasized hover:bg-secondary/60 [&_svg]:size-4 [&_svg]:text-muted-foreground"
                    >
                      <candidate.Icon aria-hidden />
                      {candidate.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-7 flex flex-wrap gap-2">
            <Link to="/" className={cn(buttonVariants({ variant: 'primary' }))}>
              <HomeIcon aria-hidden />
              {t('notFound.actions.dashboard')}
            </Link>
          </div>
        </Surface>
      </main>
    </PageContainer>
  );
}
