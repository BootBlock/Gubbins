import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import {
  PageContainer,
  PageHeader,
  Surface,
  Button,
  buttonVariants,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { WarningIcon, HomeIcon, RefreshIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';

/**
 * The routed-error screen (issue #41) — the router's `defaultErrorComponent`.
 *
 * Complements {@link NotFoundScreen}: where that catches an address that doesn't resolve, this
 * catches an error thrown while a route's loader or component runs, and dresses it in the same
 * chrome instead of the router's bare default. The top-level {@link ../../app/error/SafeMode}
 * boundary still backstops a total render collapse; this handles the recoverable, per-route case
 * where the rest of the app is fine — so it offers an in-place retry (`reset`) alongside a route
 * home, and tucks the raw error text into an opt-in disclosure rather than shouting it.
 */
export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const t = useT();
  const message = error instanceof Error ? error.message : String(error);

  return (
    <PageContainer>
      <PageHeader icon={<WarningIcon />} title={t('routeError.title')} />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col outline-none">
        <Surface className="mx-auto w-full max-w-2xl p-7">
          <div className="flex items-start gap-4">
            <span
              className="grid size-12 shrink-0 place-items-center rounded-xl bg-destructive/15 text-destructive [&_svg]:size-6"
              aria-hidden
            >
              <WarningIcon />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{t('routeError.heading')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('routeError.explanation')}</p>
            </div>
          </div>

          {message.length > 0 && (
            <details className="mt-5 rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted-foreground select-none">
                {t('routeError.details')}
              </summary>
              <p className="max-h-40 overflow-auto border-t border-border px-3 py-2 font-mono text-xs break-words text-muted-foreground">
                {message}
              </p>
            </details>
          )}

          <div className="mt-7 flex flex-wrap gap-2">
            <Button onClick={reset}>
              <RefreshIcon aria-hidden />
              {t('routeError.actions.retry')}
            </Button>
            <Link to="/" className={cn(buttonVariants({ variant: 'outline' }))}>
              <HomeIcon aria-hidden />
              {t('routeError.actions.dashboard')}
            </Link>
          </div>
        </Surface>
      </main>
    </PageContainer>
  );
}
