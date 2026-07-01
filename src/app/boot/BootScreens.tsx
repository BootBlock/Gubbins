import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Surface, Button, Spinner } from '@/components/foundry';
import { CriticalIcon, DuplicateTabIcon } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { RescueActions } from '@/app/error/RescueActions';
import type { DbError, DbErrorCode } from '@/db/errors';

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
  children,
}: {
  accent: Accent;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background p-6">
      {/* Ambient gradient glow for depth. */}
      <div className="pointer-events-none absolute top-[-30%] left-1/2 size-[55rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <Surface className="relative w-full max-w-md p-8">
        <div className="flex flex-col items-center text-center">
          <span className={cn('grid size-14 place-items-center rounded-2xl [&_svg]:size-7', ACCENT_CLASS[accent])}>
            {icon}
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children ? <div className="mt-6">{children}</div> : null}
      </Surface>
      <p className="absolute bottom-5 text-xs text-muted-foreground/60">Gubbins · local-first inventory</p>
    </div>
  );
}

export function StartingScreen() {
  return (
    <BootShell accent="brand" icon={<BrandMark className="size-9" />} title="Gubbins" subtitle="Local-first inventory tracking">
      <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
        <Spinner className="size-4 border-2" />
        <span>Opening database &amp; verifying storage…</span>
      </div>
    </BootShell>
  );
}

export function UnsupportedScreen({ missing }: { missing: readonly string[] }) {
  return (
    <BootShell
      accent="danger"
      icon={<CriticalIcon />}
      title="Browser not supported"
      subtitle="Gubbins needs modern, cross-origin-isolated storage to keep your data safe."
    >
      <div className="rounded-xl border border-border bg-secondary/40 p-4 text-sm">
        <p className="text-muted-foreground">Missing platform capabilities:</p>
        <ul className="mt-2 space-y-1.5">
          {missing.map((capability) => (
            <li key={capability} className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
              {capability}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Try the latest Chrome, Edge, or Firefox. On iOS, add Gubbins to the Home Screen first.
      </p>
    </BootShell>
  );
}

export function MultiTabScreen({ whenReleased }: { whenReleased: Promise<void> }) {
  // Automatically take over once the owning tab releases the database (spec §2.2.7).
  useEffect(() => {
    let active = true;
    void whenReleased.then(() => {
      if (active) location.reload();
    });
    return () => {
      active = false;
    };
  }, [whenReleased]);

  return (
    <BootShell
      accent="warning"
      icon={<DuplicateTabIcon />}
      title="Already open elsewhere"
      subtitle="Gubbins is running in another tab or window."
    >
      <p className="text-center text-sm text-muted-foreground">
        Your database can only be open in one place at a time, to protect it. Close the other tab — we
        will switch over here automatically.
      </p>
      <Button variant="outline" className="mt-5 w-full" onClick={() => location.reload()}>
        Use this tab
      </Button>
    </BootShell>
  );
}

const ERROR_HINTS: Partial<Record<DbErrorCode, string>> = {
  FTS5_UNAVAILABLE: "This browser's SQLite build is missing full-text search (FTS5).",
  OPFS_UNAVAILABLE: 'Secure on-device storage (OPFS) is unavailable here.',
  NOT_CROSS_ORIGIN_ISOLATED: 'The page is not cross-origin isolated, so secure storage is blocked.',
  SCHEMA_TOO_NEW: 'Your local data is from a newer schema than this build. Reset local data to rebuild it.',
  INIT_FAILED: 'The database failed to initialise.',
};

export function BootErrorScreen({ error }: { error: DbError }) {
  return (
    <BootShell
      accent="danger"
      icon={<CriticalIcon />}
      title="Couldn't start the database"
      subtitle={ERROR_HINTS[error.code] ?? 'An unexpected error occurred while starting Gubbins.'}
    >
      <p className="rounded-lg bg-secondary/50 p-3 font-mono text-xs break-words text-muted-foreground">
        {error.code}: {error.message}
      </p>
      <p className="mt-4 text-sm text-muted-foreground">Rescue your local data, or reset:</p>
      <div className="mt-3">
        <RescueActions />
      </div>
      <Button className="mt-4 w-full" onClick={() => location.reload()}>
        Reload
      </Button>
    </BootShell>
  );
}
