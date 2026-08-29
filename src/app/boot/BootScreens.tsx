import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Surface, Button, Spinner } from '@/components/foundry';
import { BlockedIcon, CriticalIcon, DuplicateTabIcon, StorageIcon, WarningIcon } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { RescueActions } from '@/app/error/RescueActions';
import { labFlag } from '@/state/stores/useLabStore';
import { useT, type MessageKey } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import type { SupportCause, SupportDiagnosis } from '@/lib/env/support-diagnosis';
import { waiveIsolation } from '@/lib/env/isolation-waiver';
import { setTabLockOverride, type TabLockDenial } from '@/db/tab-lock';
import type { DbError, DbErrorCode } from '@/db/errors';
import type { DbLossRecord } from '@/db/db-presence';

/** The public project home, linked from the boot-screen footer. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';

type Accent = 'brand' | 'warning' | 'danger';

const ACCENT_CLASS: Record<Accent, string> = {
  brand: 'bg-primary/15 text-primary',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
};

/** Shared, premium centred layout for every pre-app boot screen (spec §1.1). */
function BootShell({
  accent,
  icon,
  title,
  subtitle,
  testId,
  children,
}: {
  accent: Accent;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  /** Stable hook for tests that must assert *which* boot screen is up, independent of its copy. */
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="relative flex min-h-dvh flex-col items-center justify-center gap-5 bg-background p-6"
    >
      {/* Ambient gradient glow for depth. Clipped by its own wrapper rather than by the screen,
          so a card taller than the viewport scrolls into view instead of being cut off. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-[-30%] left-1/2 size-[55rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      </div>
      <Surface className="relative w-full max-w-md p-8">
        <div className="flex flex-col items-center text-center">
          {/* Decorative: every icon here only restates the heading below it. */}
          <span
            aria-hidden="true"
            className={cn('grid size-14 place-items-center rounded-2xl [&_svg]:size-7', ACCENT_CLASS[accent])}
          >
            {icon}
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children ? <div className="mt-6">{children}</div> : null}
      </Surface>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="relative rounded-sm text-xs text-muted-foreground/60 underline-offset-4 outline-none transition-colors hover:text-muted-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        Gubbins · local-first inventory
      </a>
    </div>
  );
}

export function StartingScreen() {
  return (
    <BootShell
      accent="brand"
      icon={<BrandMark className="size-9" />}
      title="Gubbins"
      subtitle="Local-first inventory tracking"
    >
      <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
        <Spinner className="size-4 border-2" />
        <span>Opening database &amp; verifying storage…</span>
      </div>
    </BootShell>
  );
}

interface CausePresentation {
  readonly accent: Accent;
  readonly icon: ReactNode;
  readonly title: MessageKey;
  readonly lede: MessageKey;
  /** Things the user can actually do, most likely to help first. */
  readonly steps: readonly MessageKey[];
  /** Shown instead of {@link steps} where there is nothing to do but wait. */
  readonly note?: MessageKey;
}

/**
 * How each diagnosed cause presents itself (issue #105).
 *
 * Only `browser-unsupported` blames the browser and takes the `danger` accent; the rest are
 * environmental, so they lead with what to change and stay at `warning`. `isolation-pending`
 * is not a failure at all — it is the normal first visit, waiting on the service worker that
 * supplies the COOP/COEP headers (§2.2.6) — so it reads as progress, not an error.
 *
 * `isolation-blocked` reaches this table less often since #255: where isolation is demonstrably
 * not coming, the boot now opens the database on the fallback VFS rather than stopping the user.
 * It still shows for the reading that is *not* settled — a service worker that has not reached
 * `active` yet, which is equally what a slow first install looks like, and where a reload is
 * genuinely the right advice.
 */
const CAUSE_PRESENTATION: Record<SupportCause, CausePresentation> = {
  'insecure-context': {
    accent: 'warning',
    icon: <CriticalIcon />,
    title: 'boot.unsupported.insecure.title',
    lede: 'boot.unsupported.insecure.lede',
    steps: ['boot.unsupported.insecure.step1', 'boot.unsupported.insecure.step2'],
  },
  'scripts-blocked': {
    accent: 'warning',
    icon: <BlockedIcon />,
    title: 'boot.unsupported.scripts.title',
    lede: 'boot.unsupported.scripts.lede',
    steps: [
      'boot.unsupported.scripts.step1',
      'boot.unsupported.scripts.step2',
      'boot.unsupported.scripts.step3',
    ],
  },
  'site-data-blocked': {
    accent: 'warning',
    icon: <StorageIcon />,
    title: 'boot.unsupported.siteData.title',
    lede: 'boot.unsupported.siteData.lede',
    steps: [
      'boot.unsupported.siteData.step1',
      'boot.unsupported.siteData.step2',
      'boot.unsupported.siteData.step3',
    ],
  },
  'isolation-pending': {
    accent: 'brand',
    icon: <Spinner className="size-7 border-2" decorative />,
    title: 'boot.unsupported.pending.title',
    lede: 'boot.unsupported.pending.lede',
    steps: [],
    note: 'boot.unsupported.pending.note',
  },
  'isolation-blocked': {
    accent: 'warning',
    icon: <WarningIcon />,
    title: 'boot.unsupported.isolation.title',
    lede: 'boot.unsupported.isolation.lede',
    steps: [
      'boot.unsupported.isolation.step1',
      'boot.unsupported.isolation.step2',
      'boot.unsupported.isolation.step3',
    ],
  },
  'browser-unsupported': {
    accent: 'danger',
    icon: <CriticalIcon />,
    title: 'boot.unsupported.browser.title',
    lede: 'boot.unsupported.browser.lede',
    steps: ['boot.unsupported.browser.step1', 'boot.unsupported.browser.step2'],
  },
};

/**
 * Every reading behind the verdict, as flat `name: value` lines — deliberately untranslated
 * (they are API identifiers, not prose) and copyable straight into a bug report.
 */
function technicalReport(diagnosis: SupportDiagnosis): string {
  return [
    `cause: ${diagnosis.cause}`,
    ...Object.entries(diagnosis.signals).map(([signal, value]) => `${signal}: ${value}`),
    `missing: ${diagnosis.missing.join(', ')}`,
  ].join('\n');
}

/**
 * Shown when Gubbins cannot claim the storage it needs (§2.2.6, §3).
 *
 * The name is historical: this is *not* automatically a "browser not supported" screen. A capable,
 * up-to-date browser lands here whenever something in the environment withholds those capabilities —
 * a blocked script, blocked site data, an insecure origin, or (on every first visit) the service
 * worker still starting up. It leads with the diagnosed cause and what to do about it, and only
 * blames the browser once {@link diagnoseSupport} has ruled everything else out.
 */
export function UnsupportedScreen({
  diagnosis,
  isolationWaivable = false,
}: {
  diagnosis: SupportDiagnosis;
  /**
   * The gate waited for isolation as long as it usefully could and it never arrived, so the
   * user may choose the fallback store instead of waiting further (issue #260). The screen is
   * otherwise a dead end in that state: only a service worker taking control can change the
   * reading, and reloading has already been given every chance to make that happen.
   */
  isolationWaivable?: boolean;
}) {
  const t = useT();
  const { accent, icon, title, lede, steps, note } = CAUSE_PRESENTATION[diagnosis.cause];

  return (
    <BootShell accent={accent} icon={icon} title={t(title)} subtitle={t(lede)} testId="boot-unsupported">
      {steps.length > 0 ? (
        <div className="rounded-xl border border-border bg-secondary/40 p-4 text-left text-sm">
          <p className="font-medium">{t('boot.unsupported.whatToTry')}</p>
          <ul className="mt-2 space-y-2 text-muted-foreground">
            {steps.map((step) => (
              <li key={step} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                />
                <span>{t(step)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {note ? <p className="text-center text-sm text-muted-foreground">{t(note)}</p> : null}

      <Button className="mt-4 w-full" onClick={() => location.reload()}>
        {t('boot.unsupported.reload')}
      </Button>

      {isolationWaivable ? (
        <>
          <p className="mt-4 text-sm text-muted-foreground">{t('boot.unsupported.waive.note')}</p>
          <Button
            variant="outline"
            className="mt-2 w-full"
            data-testid="boot-waive-isolation"
            onClick={() => {
              // Recorded before the reload, for the same reason the data-loss notice persists
              // its acknowledgement first: the next boot is what reads it, and it must not
              // depend on anything else happening in this one.
              waiveIsolation();
              location.reload();
            }}
          >
            {t('boot.unsupported.waive.action')}
          </Button>
        </>
      ) : null}

      {/* Same disclosure the route-error screen uses for its own "Technical details". */}
      <details className="mt-4 rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted-foreground select-none">
          {t('boot.unsupported.details')}
        </summary>
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('boot.unsupported.detailsIntro')}</p>
          {/* `whitespace-pre-wrap`, not a scroller: the `missing:` line is a long joined list, and
              a user copying this for a bug report should see all of it without scrolling sideways. */}
          <pre className="mt-2 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {technicalReport(diagnosis)}
          </pre>
        </div>
      </details>
    </BootShell>
  );
}

export function MultiTabScreen({
  reason,
  whenReleased,
}: {
  reason: TabLockDenial;
  whenReleased: Promise<void> | null;
}) {
  const t = useT();

  // Automatically take over once the owning tab releases the database (spec §2.2.7).
  // There is nothing to wait on when the guard could not arbitrate at all.
  useEffect(() => {
    if (!whenReleased) return;
    let active = true;
    void whenReleased.then(() => {
      if (active) location.reload();
    });
    return () => {
      active = false;
    };
  }, [whenReleased]);

  // `unavailable` means we could not *tell* whether another tab owns the database. The guard
  // fails closed, so say so honestly rather than claiming another tab is open, and give the
  // user the one thing they know and we don't: whether this really is the only tab.
  const unavailable = reason === 'unavailable';

  return (
    <BootShell
      accent="warning"
      icon={<DuplicateTabIcon />}
      title={t(unavailable ? 'boot.multiTab.unknown.title' : 'boot.multiTab.title')}
      subtitle={t(unavailable ? 'boot.multiTab.unknown.lede' : 'boot.multiTab.lede')}
      testId="boot-multi-tab"
    >
      <p className="text-center text-sm text-muted-foreground">
        {t(unavailable ? 'boot.multiTab.unknown.body' : 'boot.multiTab.body')}
      </p>
      <Button variant="outline" className="mt-5 w-full" onClick={() => location.reload()}>
        {t(unavailable ? 'boot.multiTab.tryAgain' : 'boot.multiTab.useThisTab')}
      </Button>
      {unavailable ? (
        <Button
          variant="ghost"
          className="mt-2 w-full"
          onClick={() => {
            setTabLockOverride();
            location.reload();
          }}
        >
          {t('boot.multiTab.openAnyway')}
        </Button>
      ) : null}
    </BootShell>
  );
}

/**
 * Shown when this boot had to *create* the database on a device that already had one (issue #505).
 *
 * The app underneath is perfectly usable — that is exactly the problem this screen exists for. A
 * browser storage wipe leaves the settings behind, so Gubbins comes back past the first-run
 * wizard, in the user's own theme, with an empty inventory and no explanation; the natural
 * reading is that Gubbins lost the data, and the natural response is to start re-entering it,
 * which turns a clean restore into a merge. So the notice blocks the way in *once*, says what
 * happened, and puts a restore one click away — then lets the user carry on. The choice is
 * recorded (see `db-presence.ts`), so closing the tab on it does not quietly bury the news.
 */
export function DataLossScreen({ loss, onContinue }: { loss: DbLossRecord; onContinue: () => void }) {
  const t = useT();
  const formatters = useFormatters();

  // Say only what was actually recorded. A device whose marker predates the count — or could not
  // be read at all — still gets the fact that a database was here, without inventing a figure.
  //
  // A recorded *zero* is dropped too, and deliberately. The count is taken at each boot, so a
  // session that added two hundred items and never restarted still reads as zero — quoting it
  // would tell the user nothing was lost at the one moment they most need to be believed.
  const items = loss.lastKnownItems;
  const lastSeen =
    loss.lastSeenAt === null
      ? t('boot.dataLoss.lastSeenUnknown')
      : items === null || items <= 0
        ? t('boot.dataLoss.lastSeen', { vars: { when: formatters.dateTime(loss.lastSeenAt) } })
        : t('boot.dataLoss.lastSeenWithItems', {
            vars: { when: formatters.dateTime(loss.lastSeenAt), count: items },
          });

  return (
    <BootShell
      accent="danger"
      icon={<StorageIcon />}
      title={t('boot.dataLoss.title')}
      subtitle={t('boot.dataLoss.lede')}
      testId="boot-data-lost"
    >
      <div className="rounded-xl border border-border bg-secondary/40 p-4 text-left text-sm">
        <p className="font-medium text-foreground">{lastSeen}</p>
        <p className="mt-2 text-muted-foreground">{t('boot.dataLoss.cause')}</p>
        <p className="mt-2 text-muted-foreground">{t('boot.dataLoss.actNow')}</p>
      </div>

      <p className="mt-4 text-sm text-muted-foreground">{t('boot.dataLoss.restoreHeading')}</p>
      <div className="mt-3">
        {/*
         * Restores only. Everything else this action set offers assumes a database worth saving
         * or a build worth reinstalling: a backup of the empty one that just replaced the user's
         * data would be worse than useless, and the purge is the very thing that has already
         * happened.
         */}
        <RescueActions restoreOnly />
      </div>

      <Button variant="ghost" className="mt-4 w-full" onClick={onContinue}>
        {t('boot.dataLoss.continue')}
      </Button>
      <p className="mt-2 text-center text-xs text-muted-foreground">{t('boot.dataLoss.continueNote')}</p>
    </BootShell>
  );
}

const ERROR_HINTS: Partial<Record<DbErrorCode, string>> = {
  FTS5_UNAVAILABLE: "This browser's SQLite build is missing full-text search (FTS5).",
  OPFS_UNAVAILABLE: 'Secure on-device storage (OPFS) is unavailable here.',
  NOT_CROSS_ORIGIN_ISOLATED: 'The page is not cross-origin isolated, so secure storage is blocked.',
  SCHEMA_TOO_NEW: 'Your local data is from a newer schema than this build. Reset local data to rebuild it.',
  SCHEMA_STALE: 'Your local data is from an earlier schema than this build. Reset local data to rebuild it.',
  INIT_FAILED: 'The database failed to initialise.',
  WORKER_UNAVAILABLE: 'The database stopped responding and cannot reconnect. Reload the page to try again.',
  WORKER_TIMEOUT: 'The database took too long to start. Reload the page to try again.',
};

export function BootErrorScreen({ error }: { error: DbError }) {
  // Both schema mismatches — data ahead of this build, or behind it — get the same
  // pre-1.0 explanation and the same backup-then-reset rescue.
  const isSchemaMismatch = error.code === 'SCHEMA_TOO_NEW' || error.code === 'SCHEMA_STALE';
  // …unless this failure was *staged* by the hidden lab flag. The database is then perfectly
  // healthy, so the screen must say so and must not offer to purge it: everything else here
  // urges the reader towards a reset, and a simulated fault that can destroy real data on one
  // confirmed click is worse than no simulation at all.
  const simulated = labFlag('schema-too-new');
  return (
    <BootShell
      accent="danger"
      icon={<CriticalIcon />}
      title="Couldn't start the database"
      subtitle={ERROR_HINTS[error.code] ?? 'An unexpected error occurred while starting Gubbins.'}
    >
      {simulated ? (
        <div
          role="status"
          data-testid="boot-error-simulated"
          className="mb-4 rounded-xl border border-warning bg-warning/10 p-4 text-left text-sm text-foreground"
        >
          <p className="font-medium">This failure is simulated.</p>
          <p className="mt-2 text-muted-foreground">
            The “pretend the local database is from a newer version” switch on the hidden lab screen is on.
            Your database was never opened and is completely unaffected. Turn the switch off — or clear this
            browser’s storage for Gubbins — and the app starts normally again. The purge action is hidden here
            for that reason.
          </p>
        </div>
      ) : null}
      {isSchemaMismatch && !simulated ? (
        <div className="mb-4 rounded-xl border border-border bg-secondary/40 p-4 text-left text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Why is Gubbins asking to reset your data?</p>
          <p className="mt-2">
            Gubbins is still in early, rapid development (before version 1.0). As new features land, the shape
            of the local database changes — and while it's this young, those changes aren't migrated
            automatically. When one arrives, existing data can't be carried forward, so Gubbins has to start
            fresh.
          </p>
          <p className="mt-2">
            This is <span className="font-medium text-foreground">expected</span> before 1.0. To keep your
            data, take the <span className="font-medium text-foreground">Back up everything (.zip)</span> copy
            below <span className="font-medium text-foreground">before</span> resetting — that is the one you
            can restore afterwards, from Sync → Backup &amp; restore using{' '}
            <span className="font-medium text-foreground">Merge</span>. Then reset to continue. Once Gubbins
            reaches 1.0, updates will preserve your data.
          </p>
        </div>
      ) : null}
      <p className="rounded-lg bg-secondary/50 p-3 font-mono text-xs break-words text-muted-foreground">
        {error.code}: {error.message}
      </p>
      <p className="mt-4 text-sm text-muted-foreground">Rescue your local data, or reset:</p>
      <div className="mt-3">
        <RescueActions allowHardReset={!simulated} />
      </div>
      <Button className="mt-4 w-full" onClick={() => location.reload()}>
        Reload
      </Button>
    </BootShell>
  );
}
