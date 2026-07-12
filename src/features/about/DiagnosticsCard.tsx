import { useId, useState } from 'react';
import { Surface, Button, buttonVariants, LiveRegion } from '@/components/foundry';
import {
  HealthCheckIcon,
  ChevronDownIcon,
  RefreshIcon,
  CopyIcon,
  CheckIcon,
  ErrorIcon,
  AlertIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import { useT, type MessageKey } from '@/features/i18n';
import { getDiagnosticsRepository } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  gatherEnvironment,
  formatDiagnosticsText,
  formatFieldValue,
  buildIssueUrl,
  DIAGNOSTIC_FIELD_ORDER,
  type Diagnostics,
  type DiagnosticVocab,
} from './diagnostics';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Collapsible Diagnostics card for the About screen (issue #9). Environment details useful when
 * reporting a problem — browser, viewport, appearance preferences, storage headroom — that are
 * **never gathered automatically**: the card starts empty and only captures anything when the
 * user presses Refresh (nothing here is inventory data or sent anywhere on its own). From there
 * the user can copy the details or open a GitHub bug report with them pre-filled (with
 * location-identifying details redacted, since that issue is public).
 */
export function DiagnosticsCard() {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const refresh = async () => {
    setBusy(true);
    try {
      // Environment (browser) and app facts (appearance prefs + entity counts + DB size) in
      // parallel. The DB snapshot is best-effort — a failure leaves those rows "Unavailable"
      // rather than aborting the whole capture.
      const [environment, snapshot] = await Promise.all([
        gatherEnvironment(),
        getDiagnosticsRepository()
          .snapshot()
          .catch(() => null),
      ]);
      const { backgroundEffect } = usePreferencesStore.getState();
      setData({
        ...environment,
        backgroundEffect,
        databaseBytes: snapshot?.databaseBytes,
        counts: snapshot?.counts,
      });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(formatDiagnosticsText(data, { redact: false }));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  // The on-screen wording follows the UI language; the copy/issue payload stays canonical English
  // (see diagnostics.ts) so a bug report reads the same for the maintainer whatever the reporter's
  // locale. This vocabulary localizes the enumerated values for display only.
  const vocab: DiagnosticVocab = {
    online: t('about.diagnostics.value.online'),
    offline: t('about.diagnostics.value.offline'),
    on: t('about.diagnostics.value.on'),
    off: t('about.diagnostics.value.off'),
    light: t('about.diagnostics.value.light'),
    dark: t('about.diagnostics.value.dark'),
    installed: t('about.diagnostics.value.installed'),
    browserTab: t('about.diagnostics.value.browserTab'),
    unavailable: t('about.diagnostics.value.unavailable'),
  };

  return (
    // Matches the translucent, non-blurred tint of the sibling About cards so it sits in the same
    // starfield layer (see AboutScreen's AboutSection for why the blur is dropped).
    <Surface className="bg-card/60 p-5 backdrop-blur-none">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center gap-2.5 rounded-lg text-left text-muted-foreground outline-none transition-colors ease-emphasized hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
        >
          <HealthCheckIcon aria-hidden />
          <span className="text-sm font-semibold text-foreground">{t('about.diagnostics.title')}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn('ml-auto transition-transform ease-emphasized', open && 'rotate-180')}
          />
        </button>
      </h2>

      {open ? (
        <div id={panelId} className="mt-4">
          <p className="text-sm text-muted-foreground">{t('about.diagnostics.intro')}</p>

          {data ? (
            <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              {DIAGNOSTIC_FIELD_ORDER.map((key) => (
                // `contents` collapses the wrapper so its dt/dd become items of the parent grid,
                // keeping every row's label column aligned.
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">
                    {t(`about.diagnostics.field.${key}` as MessageKey)}
                  </dt>
                  <dd className="min-w-0 break-words font-medium">
                    {formatFieldValue(key, data, vocab, false)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{t('about.diagnostics.empty')}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
              <RefreshIcon aria-hidden className={cn(busy && 'animate-spin')} />
              {t('about.diagnostics.refresh')}
            </Button>

            {data ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copy}
                  className={cn(
                    copyState === 'copied' && 'text-glyph-success',
                    copyState === 'failed' && 'text-glyph-danger',
                  )}
                >
                  {copyState === 'copied' ? (
                    <CheckIcon aria-hidden />
                  ) : copyState === 'failed' ? (
                    <ErrorIcon aria-hidden />
                  ) : (
                    <CopyIcon aria-hidden />
                  )}
                  {copyState === 'copied'
                    ? t('about.diagnostics.copied')
                    : copyState === 'failed'
                      ? t('about.diagnostics.copyFailed')
                      : t('about.diagnostics.copy')}
                </Button>

                <a
                  href={buildIssueUrl(data)}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <AlertIcon aria-hidden />
                  {t('about.diagnostics.openIssue')}
                </a>
              </>
            ) : null}
          </div>

          {data ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('about.diagnostics.privacyNote')}</p>
          ) : null}

          {/* Announce the copy outcome for assistive tech; the region is always mounted. */}
          <LiveRegion visuallyHidden>
            {copyState === 'copied' ? (
              <p>{t('about.diagnostics.copiedAnnounce')}</p>
            ) : copyState === 'failed' ? (
              <p>{t('about.diagnostics.copyFailedAnnounce')}</p>
            ) : null}
          </LiveRegion>
        </div>
      ) : null}
    </Surface>
  );
}
