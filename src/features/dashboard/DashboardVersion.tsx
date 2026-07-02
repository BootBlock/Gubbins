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

/** Release date formatted once for display (the constant never changes at runtime). */
const RELEASE_LABEL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}).format(new Date(`${APP_RELEASE_DATE}T00:00:00`));

type CheckStatus = 'idle' | 'checking' | 'checked';

export function DashboardVersion() {
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

  const subtitle = status === 'checking' ? 'Checking…' : status === 'checked' ? 'Up to date' : RELEASE_LABEL;

  return (
    <Tooltip
      content={`**Check for updates**\n\nGubbins v${APP_VERSION}, released ${RELEASE_LABEL}.`}
      className="ml-auto"
      triggerTabIndex={-1}
    >
      <button
        type="button"
        onClick={() => void check()}
        aria-label="Check for app updates"
        data-testid="dashboard-version"
        className="cursor-pointer rounded text-right text-xs leading-tight text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="block font-medium tabular-nums text-foreground">v{APP_VERSION}</span>
        <span className="block tabular-nums" aria-live="polite">
          {subtitle}
        </span>
      </button>
    </Tooltip>
  );
}
