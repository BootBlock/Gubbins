import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, Surface, Tooltip } from '@/components/foundry';
import {
  BrandIcon,
  DatabaseIcon,
  StorageIcon,
  SuccessIcon,
  ErrorIcon,
  SecureIcon,
  PackageIcon,
  ProjectIcon,
  InfoIcon,
  CloudIcon,
} from '@/components/icons';
import { useBootResult } from '@/app/boot/boot-context';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { formatBytes, formatPercent } from '@/lib/format';
import { LifecycleAlerts } from './LifecycleAlerts';

/**
 * Phase 1 landing — a polished System Status board confirming the whole local-first
 * stack is live (SQLite + FTS5 + OPFS + migrations + storage). The customisable
 * widget dashboard proper (spec §3) is built out in later phases.
 */
export function DashboardScreen() {
  const { diagnostics, migration } = useBootResult();
  const persisted = useStorageStore((state) => state.persisted);
  const estimate = useStorageStore((state) => state.estimate);
  const ratio = useStorageStore((state) => state.ratio);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
      <header className="flex items-center gap-4">
        <span className="grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary [&_svg]:size-7">
          <BrandIcon />
        </span>
        <div>
          <h1 className="bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
            Gubbins
          </h1>
          <p className="text-sm text-muted-foreground">Local-first inventory · foundation ready</p>
        </div>
        <Link to="/sync" className={cn(buttonVariants({ variant: 'outline' }), 'ml-auto')}>
          <CloudIcon />
          Sync
        </Link>
        <Link to="/projects" className={cn(buttonVariants({ variant: 'outline' }))}>
          <ProjectIcon />
          Projects
        </Link>
        <Link to="/inventory" className={cn(buttonVariants())}>
          <PackageIcon />
          Open inventory
        </Link>
      </header>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatusCard icon={<DatabaseIcon />} title="Database">
          <Row label="Engine">SQLite {diagnostics.sqliteVersion}</Row>
          <Row label="Storage VFS">{diagnostics.vfs.toUpperCase()}</Row>
          <Row label="Full-text search">
            <Pill ok={diagnostics.fts5Available}>{diagnostics.fts5Available ? 'FTS5 ready' : 'Unavailable'}</Pill>
          </Row>
          <Row label="Schema version">
            v{diagnostics.userVersion}
            {migration.applied.length > 0 ? (
              <span className="ml-2 text-xs text-muted-foreground">
                (migrated {migration.from} → {migration.to})
              </span>
            ) : null}
          </Row>
        </StatusCard>

        <StatusCard
          icon={<StorageIcon />}
          title="Storage"
          info={[
            "This is the **browser's own estimate** for the whole origin — not Gubbins' data alone.",
            '',
            'On `localhost` it includes **every site and dev server** sharing that origin, so the figure can look large even when your inventory is empty. Your actual database is only a few kilobytes.',
            '',
            'The storage safeguards use the **percentage** of quota, so a high shared figure will not trip a false [Hard Stop](https://developer.mozilla.org/docs/Web/API/StorageManager/estimate).',
          ].join('\n')}
        >
          <Row label="Persistence">
            <Pill ok={persisted}>{persisted ? 'Persistent' : 'Ephemeral'}</Pill>
          </Row>
          <Row label="Used">
            {estimate && estimate.supported ? `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)}` : 'Unknown'}
          </Row>
          <Row label="Capacity used">{estimate && estimate.supported ? formatPercent(ratio) : '—'}</Row>
        </StatusCard>

        <StatusCard icon={<SecureIcon />} title="Platform">
          <Row label="Cross-origin isolated">
            <Pill ok={typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated}>
              {typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 'Isolated' : 'No'}
            </Pill>
          </Row>
          <Row label="SharedArrayBuffer">
            <Pill ok={typeof SharedArrayBuffer !== 'undefined'}>
              {typeof SharedArrayBuffer !== 'undefined' ? 'Available' : 'Missing'}
            </Pill>
          </Row>
          <Row label="Database file">
            <span className="font-mono text-xs">{diagnostics.filename}</span>
          </Row>
        </StatusCard>
      </div>

      <LifecycleAlerts />

      <Surface className="mt-6 p-6">
        <h2 className="text-sm font-semibold">Inventory is live</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The core domain model is in place: nested locations, items with Bulk, Serialised and Consumable
          Gauge tracking, an immutable Activity Log, and virtualised lists with a Data-Heavy ↔ Visual-Heavy
          toggle. Head to the inventory workspace to create, move and track your gubbins.
        </p>
      </Surface>
    </main>
  );
}

function StatusCard({
  icon,
  title,
  info,
  children,
}: {
  icon: ReactNode;
  title: string;
  info?: string;
  children: ReactNode;
}) {
  return (
    <Surface className="p-5 transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {info ? (
          <Tooltip content={info} className="ml-auto text-muted-foreground/70 hover:text-foreground">
            <InfoIcon className="size-3.5" aria-label={`About ${title}`} />
          </Tooltip>
        ) : null}
      </div>
      <dl className="mt-4 space-y-2.5">{children}</dl>
    </Surface>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center font-medium">{children}</dd>
    </div>
  );
}

function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium [&_svg]:size-3.5',
        ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
      )}
    >
      {ok ? <SuccessIcon /> : <ErrorIcon />}
      {children}
    </span>
  );
}
