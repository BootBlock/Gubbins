/**
 * Dashboard widget registry (spec §3 "Customisable Dashboard": "Users can pin
 * specific visualisations, 'Low Stock Alerts', 'Soon to Expire' trackers, 'Overdue
 * Items', Project statuses, or quick-links").
 *
 * Each widget is a self-contained component that fetches its own Tier-1 data, so the
 * grid (`DashboardGrid`) only places, reorders, shows/hides and persists them — it
 * never knows what's inside a tile. The registry order is the row-major default
 * layout; the pure `dashboard-layout.ts` seam owns all the coordinate maths.
 */
import type { ComponentType, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import {
  DatabaseIcon,
  StorageIcon,
  SecureIcon,
  SuccessIcon,
  ErrorIcon,
  InfoIcon,
  ExpiryIcon,
  DueDateIcon,
  MaintenanceIcon,
  TruckIcon,
  LowStockIcon,
  ProjectIcon,
  LinkIcon,
  PackageIcon,
  ContactsIcon,
  CloudIcon,
  SettingsIcon,
} from '@/components/icons';
import { useBootResult } from '@/app/boot/boot-context';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFormatters } from '@/lib/useFormatters';
import { ChangeFlash } from '@/features/inventory/components/ChangeFlash';
import { useExpiringItems, useLowStockItems, useInTransitLines, useDueMaintenance } from '@/features/lifecycle';
import { useOpenCheckouts } from '@/features/contacts/contacts';
import { useProjects } from '@/features/projects/projects';

export interface WidgetDefinition {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Optional quick-link target — the whole tile navigates here in view mode. */
  readonly to?: string;
  readonly Component: ComponentType;
}

type Tone = 'quiet' | 'info' | 'warning' | 'danger';

const TONE_COUNT: Record<Tone, string> = {
  quiet: 'text-muted-foreground',
  info: 'text-primary',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/** Shared widget card inner: an icon+title header, an optional count, and a body. */
function WidgetShell({
  icon,
  title,
  count,
  tone = 'quiet',
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {count !== undefined ? (
          <ChangeFlash flashKey={count} className={cn('ml-auto text-lg font-semibold tabular-nums', TONE_COUNT[tone])}>
            {count}
          </ChangeFlash>
        ) : null}
      </div>
      <div className="mt-2 space-y-1">{children}</div>
    </>
  );
}

function WidgetRow({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate font-medium">{label}</span>
      {meta ? <span className="shrink-0 text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center font-medium">{children}</span>
    </div>
  );
}

function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3',
        ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
      )}
    >
      {ok ? <SuccessIcon /> : <ErrorIcon />}
      {children}
    </span>
  );
}

// --- Lifecycle / inventory widgets ---------------------------------------------

function LowStockWidget() {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const lowStock = useLowStockItems({ qtyThreshold, gaugePercent });
  const rows = lowStock.data?.rows ?? [];
  return (
    <WidgetShell icon={<LowStockIcon />} title="Low stock" count={rows.length} tone={rows.length > 0 ? 'warning' : 'quiet'}>
      {rows.length === 0 ? (
        <EmptyRow>Stock levels healthy.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((item) => (
          <WidgetRow
            key={item.id}
            label={item.name}
            meta={
              item.gauge
                ? `${Math.round(item.gauge.percentageRemaining)}%`
                : `×${item.quantity}`
            }
          />
        ))
      )}
    </WidgetShell>
  );
}

function ExpiringWidget() {
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);
  const fmt = useFormatters();
  const expiring = useExpiringItems(expirySoonWindowDays);
  const rows = expiring.data?.rows ?? [];
  return (
    <WidgetShell icon={<ExpiryIcon />} title="Soon to expire" count={rows.length} tone={rows.length > 0 ? 'warning' : 'quiet'}>
      {rows.length === 0 ? (
        <EmptyRow>All clear.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((item) => (
          <WidgetRow key={item.id} label={item.name} meta={item.expiryDate ? fmt.date(item.expiryDate) : undefined} />
        ))
      )}
    </WidgetShell>
  );
}

function OverdueWidget() {
  const openCheckouts = useOpenCheckouts();
  const overdue = (openCheckouts.data?.rows ?? []).filter((c) => c.isOverdue);
  return (
    <WidgetShell icon={<DueDateIcon />} title="Overdue items" count={overdue.length} tone={overdue.length > 0 ? 'danger' : 'quiet'}>
      {overdue.length === 0 ? (
        <EmptyRow>Nothing overdue.</EmptyRow>
      ) : (
        overdue.slice(0, 3).map((c) => <WidgetRow key={c.id} label={c.itemName} meta={`with ${c.contactName}`} />)
      )}
    </WidgetShell>
  );
}

function MaintenanceWidget() {
  const dueMaintenance = useDueMaintenance();
  const rows = dueMaintenance.data?.rows ?? [];
  return (
    <WidgetShell icon={<MaintenanceIcon />} title="Maintenance due" count={rows.length} tone={rows.length > 0 ? 'warning' : 'quiet'}>
      {rows.length === 0 ? (
        <EmptyRow>Nothing due.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((m) => <WidgetRow key={m.id} label={m.itemName} meta={m.name} />)
      )}
    </WidgetShell>
  );
}

function InTransitWidget() {
  const inTransit = useInTransitLines();
  const rows = inTransit.data?.rows ?? [];
  return (
    <WidgetShell icon={<TruckIcon />} title="In transit" count={rows.length} tone={rows.length > 0 ? 'info' : 'quiet'}>
      {rows.length === 0 ? (
        <EmptyRow>Nothing inbound.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((line) => (
          // Show the quantity still to arrive — part-received lines surface only their
          // outstanding remainder (§4 split receipts, Phase 24).
          <WidgetRow key={line.lineId} label={line.label} meta={`×${Math.max(0, line.requiredQty - line.receivedQty)}`} />
        ))
      )}
    </WidgetShell>
  );
}

function ProjectsWidget() {
  const projects = useProjects();
  // Surface the live (non-archived) projects with their lifecycle status (§3).
  const active = (projects.data?.rows ?? []).filter((p) => p.status !== 'ARCHIVED');
  return (
    <WidgetShell icon={<ProjectIcon />} title="Project statuses" count={active.length} tone={active.length > 0 ? 'info' : 'quiet'}>
      {active.length === 0 ? (
        <EmptyRow>No active projects.</EmptyRow>
      ) : (
        active.slice(0, 3).map((p) => <WidgetRow key={p.id} label={p.name} meta={p.status.toLowerCase()} />)
      )}
    </WidgetShell>
  );
}

function QuickLinksWidget() {
  const links = [
    { to: '/inventory', label: 'Inventory', icon: <PackageIcon /> },
    { to: '/projects', label: 'Projects', icon: <ProjectIcon /> },
    { to: '/contacts', label: 'Contacts', icon: <ContactsIcon /> },
    { to: '/sync', label: 'Cloud Sync', icon: <CloudIcon /> },
    { to: '/settings', label: 'Settings', icon: <SettingsIcon /> },
  ] as const;
  return (
    <WidgetShell icon={<LinkIcon />} title="Quick links">
      <div className="grid grid-cols-2 gap-1.5">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
          >
            {l.icon}
            {l.label}
          </Link>
        ))}
      </div>
    </WidgetShell>
  );
}

// --- System-status widgets (Phase 1 board, now pinnable) -----------------------

function DatabaseWidget() {
  const { diagnostics, migration } = useBootResult();
  return (
    <WidgetShell icon={<DatabaseIcon />} title="Database">
      <StatusRow label="Engine">SQLite {diagnostics.sqliteVersion}</StatusRow>
      <StatusRow label="Storage VFS">{diagnostics.vfs.toUpperCase()}</StatusRow>
      <StatusRow label="Full-text search">
        <Pill ok={diagnostics.fts5Available}>{diagnostics.fts5Available ? 'FTS5' : 'No FTS5'}</Pill>
      </StatusRow>
      <StatusRow label="Schema">
        v{diagnostics.userVersion}
        {migration.applied.length > 0 ? (
          <span className="ml-1 text-muted-foreground">
            ({migration.from}→{migration.to})
          </span>
        ) : null}
      </StatusRow>
    </WidgetShell>
  );
}

function StorageWidget() {
  const persisted = useStorageStore((state) => state.persisted);
  const estimate = useStorageStore((state) => state.estimate);
  const ratio = useStorageStore((state) => state.ratio);
  const fmt = useFormatters();
  return (
    <WidgetShell
      icon={<StorageIcon />}
      title="Storage"
    >
      <StatusRow label="Persistence">
        <Pill ok={persisted}>{persisted ? 'Persistent' : 'Ephemeral'}</Pill>
      </StatusRow>
      <StatusRow label="Used">
        {estimate && estimate.supported ? `${fmt.bytes(estimate.usage)} / ${fmt.bytes(estimate.quota)}` : 'Unknown'}
      </StatusRow>
      <StatusRow label="Capacity">
        <span className="flex items-center gap-1">
          {estimate && estimate.supported ? fmt.percent(ratio) : '—'}
          <Tooltip
            content="The browser's estimate for the whole origin, not Gubbins alone. The safeguards use the percentage, so a high shared figure won't trip a false Hard Stop."
            openDelayMs={INFO_OPEN_DELAY_MS}
          >
            <InfoIcon className="size-3 text-muted-foreground/70" aria-label="About storage" />
          </Tooltip>
        </span>
      </StatusRow>
    </WidgetShell>
  );
}

function PlatformWidget() {
  const { diagnostics } = useBootResult();
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const sab = typeof SharedArrayBuffer !== 'undefined';
  return (
    <WidgetShell icon={<SecureIcon />} title="Platform">
      <StatusRow label="Cross-origin isolated">
        <Pill ok={isolated}>{isolated ? 'Isolated' : 'No'}</Pill>
      </StatusRow>
      <StatusRow label="SharedArrayBuffer">
        <Pill ok={sab}>{sab ? 'Available' : 'Missing'}</Pill>
      </StatusRow>
      <StatusRow label="DB file">
        <span className="font-mono text-[11px]">{diagnostics.filename}</span>
      </StatusRow>
    </WidgetShell>
  );
}

/**
 * The widget registry in default row-major order. The actionable inventory trackers
 * come first, then quick-links, then the system-status board — but the user is free to
 * reorder, hide or re-pin any of them.
 */
export const DASHBOARD_WIDGETS: readonly WidgetDefinition[] = [
  { id: 'low-stock', title: 'Low stock', icon: <LowStockIcon />, to: '/inventory', Component: LowStockWidget },
  { id: 'expiring', title: 'Soon to expire', icon: <ExpiryIcon />, to: '/inventory', Component: ExpiringWidget },
  { id: 'overdue', title: 'Overdue items', icon: <DueDateIcon />, to: '/contacts', Component: OverdueWidget },
  { id: 'maintenance', title: 'Maintenance due', icon: <MaintenanceIcon />, to: '/inventory', Component: MaintenanceWidget },
  { id: 'in-transit', title: 'In transit', icon: <TruckIcon />, to: '/inventory', Component: InTransitWidget },
  { id: 'projects', title: 'Project statuses', icon: <ProjectIcon />, to: '/projects', Component: ProjectsWidget },
  { id: 'quick-links', title: 'Quick links', icon: <LinkIcon />, Component: QuickLinksWidget },
  { id: 'system-database', title: 'Database', icon: <DatabaseIcon />, Component: DatabaseWidget },
  { id: 'system-storage', title: 'Storage', icon: <StorageIcon />, Component: StorageWidget },
  { id: 'system-platform', title: 'Platform', icon: <SecureIcon />, Component: PlatformWidget },
];

/** Stable registry id list — the input to `reconcileLayout`/`defaultLayout`. */
export const DASHBOARD_WIDGET_IDS: readonly string[] = DASHBOARD_WIDGETS.map((w) => w.id);

/** Look up a widget definition by id (the grid renders placements by id). */
export function widgetById(id: string): WidgetDefinition | undefined {
  return DASHBOARD_WIDGETS.find((w) => w.id === id);
}
