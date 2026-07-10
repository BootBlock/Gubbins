/**
 * DashboardVersion — the version + release date shown in the dashboard hero (landing-page
 * only). Clicking it runs a manual check for a newer build: it asks the service worker to
 * re-fetch, and if a newer version exists the app-wide PwaUpdatePrompt surfaces its
 * "Reload now" prompt. A short "Checking… / Up to date" status gives the click feedback.
 */
import { useRef, useState } from 'react';
import { Tooltip } from '@/components/foundry';
import { checkForAppUpdate } from '@/components/foundry/usePwaUpdate';
import { APP_VERSION, APP_RELEASE_DATE } from '@/lib/app-version';
import { useT } from '@/features/i18n';

/** Release date formatted once for display (the constant never changes at runtime). */
const RELEASE_LABEL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}).format(new Date(`${APP_RELEASE_DATE}T00:00:00`));

type CheckStatus = 'idle' | 'checking' | 'checked';

export function DashboardVersion() {
  const t = useT();
  const [status, setStatus] = useState<CheckStatus>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = async () => {
    if (status === 'checking') return;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus('checking');
    // Keep "Checking…" on screen briefly even if the check resolves instantly (a no-op in
    // dev / unsupported browsers), so the click visibly registers.
    await Promise.all([checkForAppUpdate().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
    setStatus('checked');
    resetTimer.current = setTimeout(() => setStatus('idle'), 2500);
  };

  const subtitle =
    status === 'checking'
      ? t('dashboard.version.checking')
      : status === 'checked'
        ? t('dashboard.version.upToDate')
        : RELEASE_LABEL;

  return (
    <Tooltip
      content={t('dashboard.version.tooltip', { vars: { version: APP_VERSION, date: RELEASE_LABEL } })}
      className="ml-auto"
      triggerTabIndex={-1}
    >
      <button
        type="button"
        onClick={() => void check()}
        aria-label={t('dashboard.version.check')}
        data-testid="dashboard-version"
        className="cursor-pointer rounded text-right text-xs leading-tight text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="block font-medium tabular-nums text-foreground">v{APP_VERSION}</span>
        <span className="block tabular-nums" aria-live="polite">
          {subtitle}
        </span>
      </button>
    </Tooltip>
  );
}
