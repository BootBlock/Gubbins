/**
 * Dashboard widget registry (spec §3 "Customisable Dashboard": "Users can pin
 * specific visualisations, 'Low Stock Alerts', 'Soon to Expire' trackers, 'Overdue
 * Items', or Project statuses").
 *
 * Each widget is a self-contained component that fetches its own Tier-1 data, so the
 * grid (`DashboardGrid`) only places, reorders, shows/hides and persists them — it
 * never knows what's inside a tile. The registry order is the row-major default
 * layout; the pure `dashboard-layout.ts` seam owns all the coordinate maths.
 */
import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Money, AnimatedNumber, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
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
  BudgetIcon,
  HistoryIcon,
  ValueIcon,
} from '@/components/icons';
import { useBootResult } from '@/app/boot/boot-context';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFormatters } from '@/lib/useFormatters';
import { shortfall } from '@/features/inventory/reorder-policy';
import {
  useExpiringItems,
  useLowStockItems,
  useInTransitLines,
  useDueMaintenance,
} from '@/features/lifecycle';
import { useOpenCheckouts } from '@/features/contacts/contacts';
import { useProjects, useBudgetAlerts } from '@/features/projects/projects';
import { budgetStatus } from '@/features/projects/budget';
import { useItemCount, useLocations } from '@/features/inventory/queries';
import { useCategories } from '@/features/inventory/categories';
import { useInventoryValue } from '@/features/reports/queries';
import { useActivityFeed } from '@/features/activity/queries';
import { describeHistoryEntry } from '@/features/inventory/history-format';
import type { FeatureId } from '@/features/modules/feature-registry';

export interface WidgetDefinition {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Optional quick-link target — the whole tile navigates here in view mode. */
  readonly to?: string;
  /**
   * The Modular UI feature this widget belongs to (modular-ui-plan §4). When the feature
   * is not in the effective-enabled set the grid drops the widget from the board *and* the
   * "Customise" picker. A widget with no `feature` is always shown — either it's core
   * inventory (low stock, totals) or app-status plumbing (database/storage/platform) that
   * makes sense regardless of which modules are on. Note this gates the *widget*; a
   * surviving widget whose `to` points at a hidden route drops only its link (see
   * `featureForRoute`), it isn't removed.
   */
  readonly feature?: FeatureId;
  readonly Component: ComponentType;
}

type Tone = 'quiet' | 'info' | 'warning' | 'danger';

const TONE_COUNT: Record<Tone, string> = {
  quiet: 'text-muted-foreground',
  info: 'text-primary',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/** Shared widget card inner: an icon+title header, an optional count, and a body.
 *
 * `loading`/`error` distinguish a query still in flight (or failed) from a genuinely
 * empty result — without them a brief load reads as "all clear", and a failed query
 * silently shows the empty state (improvement #6). While loading or errored the count is
 * suppressed (it isn't known yet) and the body shows a skeleton / quiet message. */
function WidgetShell({
  icon,
  title,
  count,
  tone = 'quiet',
  loading = false,
  error = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  tone?: Tone;
  loading?: boolean;
  error?: boolean;
  children: ReactNode;
}) {
  const showCount = count !== undefined && !loading && !error;
  return (
    <>
      <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {showCount ? (
          // The ticker rolls to the new figure and plays a settle-pop, so a count that
          // changes while the board is open reads as live (replaces the old colour-only
          // glow). Reduced-motion users get the figure instantly (the primitive snaps).
          <AnimatedNumber value={count} className={cn('ml-auto text-lg font-semibold', TONE_COUNT[tone])} />
        ) : null}
      </div>
      <div className="mt-2 space-y-1">
        {error ? (
          <p className="text-xs text-warning">Couldn’t load this widget.</p>
        ) : loading ? (
          <WidgetSkeleton />
        ) : (
          children
        )}
      </div>
    </>
  );
}

/** A couple of muted pulsing bars while a widget's data is loading. */
function WidgetSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden data-testid="widget-skeleton">
      <div className="shimmer h-3 w-3/4 rounded" />
      <div className="shimmer h-3 w-1/2 rounded" />
    </div>
  );
}

function WidgetRow({ label, meta }: { label: string; meta?: ReactNode }) {
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
  const defaults = { qtyThreshold, gaugePercent };
  return (
    <WidgetShell
      icon={<LowStockIcon />}
      title="Low stock"
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={lowStock.isPending}
      error={lowStock.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>Stock levels healthy.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((item) => {
          // For a low discrete item, surface the suggested top-up (its own reorder
          // quantity, else the shortfall back up to its effective reorder point).
          const toReorder = shortfall(item, defaults);
          return (
            <WidgetRow
              key={item.id}
              label={item.name}
              meta={
                item.gauge
                  ? `${Math.round(item.gauge.percentageRemaining)}%`
                  : toReorder > 0
                    ? `×${item.quantity} · reorder ${toReorder}`
                    : `×${item.quantity}`
              }
            />
          );
        })
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
    <WidgetShell
      icon={<ExpiryIcon />}
      title="Soon to expire"
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={expiring.isPending}
      error={expiring.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>All clear.</EmptyRow>
      ) : (
        rows
          .slice(0, 3)
          .map((item) => (
            <WidgetRow
              key={item.id}
              label={item.name}
              meta={item.expiryDate ? fmt.date(item.expiryDate) : undefined}
            />
          ))
      )}
    </WidgetShell>
  );
}

function OverdueWidget() {
  const openCheckouts = useOpenCheckouts();
  const overdue = (openCheckouts.data?.rows ?? []).filter((c) => c.isOverdue);
  return (
    <WidgetShell
      icon={<DueDateIcon />}
      title="Overdue items"
      count={overdue.length}
      tone={overdue.length > 0 ? 'danger' : 'quiet'}
      loading={openCheckouts.isPending}
      error={openCheckouts.isError}
    >
      {overdue.length === 0 ? (
        <EmptyRow>Nothing overdue.</EmptyRow>
      ) : (
        overdue
          .slice(0, 3)
          .map((c) => <WidgetRow key={c.id} label={c.itemName} meta={`with ${c.contactName}`} />)
      )}
    </WidgetShell>
  );
}

function MaintenanceWidget() {
  const dueMaintenance = useDueMaintenance();
  const rows = dueMaintenance.data?.rows ?? [];
  return (
    <WidgetShell
      icon={<MaintenanceIcon />}
      title="Maintenance due"
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={dueMaintenance.isPending}
      error={dueMaintenance.isError}
    >
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
    <WidgetShell
      icon={<TruckIcon />}
      title="In transit"
      count={rows.length}
      tone={rows.length > 0 ? 'info' : 'quiet'}
      loading={inTransit.isPending}
      error={inTransit.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>Nothing inbound.</EmptyRow>
      ) : (
        rows.slice(0, 3).map((line) => (
          // Show the quantity still to arrive — part-received lines surface only their
          // outstanding remainder (§4 split receipts, Phase 24).
          <WidgetRow
            key={line.lineId}
            label={line.label}
            meta={`×${Math.max(0, line.requiredQty - line.receivedQty)}`}
          />
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
    <WidgetShell
      icon={<ProjectIcon />}
      title="Project statuses"
      count={active.length}
      tone={active.length > 0 ? 'info' : 'quiet'}
      loading={projects.isPending}
      error={projects.isError}
    >
      {active.length === 0 ? (
        <EmptyRow>No active projects.</EmptyRow>
      ) : (
        active.slice(0, 3).map((p) => <WidgetRow key={p.id} label={p.name} meta={p.status.toLowerCase()} />)
      )}
    </WidgetShell>
  );
}

function BudgetAlertsWidget() {
  const warnPercent = usePreferencesStore((s) => s.budgetWarnPercent);
  const fmt = useFormatters();
  const alerts = useBudgetAlerts();
  // Flag projects whose spend so far (BOM commitments + manual expenses) — or whose
  // projected final cost — is at/over budget. Only budgeted projects are returned, so an
  // empty result simply means everything is on track (§3 "Budget alerts").
  const flagged = (alerts.data ?? [])
    .map((a) => {
      const spentSoFar = a.committedFromBom + a.manualExpenseTotal;
      const projectedFinalCost = a.estimatedCost + a.manualExpenseTotal;
      const status = budgetStatus(spentSoFar, a.budget, warnPercent);
      const projectedStatus = budgetStatus(projectedFinalCost, a.budget, warnPercent);
      const over = status === 'OVER' || projectedStatus === 'OVER';
      const warn = status === 'WARN' || projectedStatus === 'WARN';
      return { ...a, spentSoFar, over, warn };
    })
    .filter((a) => a.over || a.warn)
    // Surface the worst offenders first: over-budget before merely-warning.
    .sort((a, b) => Number(b.over) - Number(a.over));

  const tone: Tone = flagged.some((a) => a.over)
    ? 'danger'
    : flagged.some((a) => a.warn)
      ? 'warning'
      : 'quiet';
  return (
    <WidgetShell
      icon={<BudgetIcon />}
      title="Budget alerts"
      count={flagged.length}
      tone={tone}
      loading={alerts.isPending}
      error={alerts.isError}
    >
      {flagged.length === 0 ? (
        <EmptyRow>All budgets on track.</EmptyRow>
      ) : (
        flagged.slice(0, 3).map((a) => (
          <WidgetRow
            key={a.projectId}
            label={a.projectName}
            meta={
              <>
                <Money value={a.spentSoFar} formatters={fmt} /> / <Money value={a.budget} formatters={fmt} />
              </>
            }
          />
        ))
      )}
    </WidgetShell>
  );
}

function InventoryTotalsWidget() {
  const fmt = useFormatters();
  const value = useInventoryValue();
  const itemCount = useItemCount();
  const locations = useLocations();
  const categories = useCategories();
  // "How big is my inventory, and what's it worth" — the at-a-glance pulse the
  // exception-list widgets don't provide. Values reuse the Reports valuation (Phase 74).
  const totalItems = itemCount.data ?? 0;
  const totalValue = value.data?.totalValue ?? 0;
  const locationCount = locations.data?.rows.length ?? 0;
  const categoryCount = categories.data?.rows.length ?? 0;
  const loading = value.isPending || itemCount.isPending || locations.isPending || categories.isPending;
  const error = value.isError || itemCount.isError || locations.isError || categories.isError;
  return (
    <WidgetShell icon={<ValueIcon />} title="Inventory totals" loading={loading} error={error}>
      {/* The at-a-glance pulse — its headline figures "count in" from zero on load (and
          roll on any later change). Reduced motion snaps to the final value. */}
      <StatusRow label="Items">
        <AnimatedNumber value={totalItems} animateOnMount />
      </StatusRow>
      <StatusRow label="Stock value">
        <Money value={totalValue} formatters={fmt} />
      </StatusRow>
      <StatusRow label="Locations">
        <AnimatedNumber value={locationCount} animateOnMount />
      </StatusRow>
      <StatusRow label="Categories">
        <AnimatedNumber value={categoryCount} animateOnMount />
      </StatusRow>
    </WidgetShell>
  );
}

function RecentActivityWidget() {
  // The global activity feed (Phase 80), newest-first — a *continuity* list so the user
  // can pick up what they were last working on, unlike the exception trackers. Reuses the
  // pure describeHistoryEntry seam (Phase 52) for each row's label.
  const feed = useActivityFeed(undefined);
  const rows = (feed.data?.pages.flatMap((p) => p.rows) ?? []).slice(0, 4);
  return (
    <WidgetShell icon={<HistoryIcon />} title="Recent activity" loading={feed.isPending} error={feed.isError}>
      {rows.length === 0 ? (
        <EmptyRow>No recent changes.</EmptyRow>
      ) : (
        rows.map((entry) => (
          <WidgetRow key={entry.id} label={entry.itemName} meta={describeHistoryEntry(entry).label} />
        ))
      )}
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
    <WidgetShell icon={<StorageIcon />} title="Storage">
      <StatusRow label="Persistence">
        <Pill ok={persisted}>{persisted ? 'Persistent' : 'Ephemeral'}</Pill>
      </StatusRow>
      <StatusRow label="Used">
        {estimate && estimate.supported
          ? `${fmt.bytes(estimate.usage)} / ${fmt.bytes(estimate.quota)}`
          : 'Unknown'}
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
      <Tooltip content="Manage &amp; erase data" openDelayMs={INFO_OPEN_DELAY_MS} triggerTabIndex={-1}>
        <p className="mt-1 text-[11px] text-muted-foreground/60">Manage storage &amp; erase data &rarr;</p>
      </Tooltip>
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
 * come first, then the system-status board — but the user is free to reorder, hide or
 * re-pin any of them.
 */
export const DASHBOARD_WIDGETS: readonly WidgetDefinition[] = [
  // Core inventory pulse — no feature gate; only its `to: /reports` link is conditional.
  {
    id: 'inventory-totals',
    title: 'Inventory totals',
    icon: <ValueIcon />,
    to: '/reports',
    Component: InventoryTotalsWidget,
  },
  // Low stock is core reorder inventory — always meaningful, so no feature gate.
  {
    id: 'low-stock',
    title: 'Low stock',
    icon: <LowStockIcon />,
    to: '/inventory',
    Component: LowStockWidget,
  },
  {
    id: 'expiring',
    title: 'Soon to expire',
    icon: <ExpiryIcon />,
    to: '/inventory',
    feature: 'perishables',
    Component: ExpiringWidget,
  },
  {
    id: 'overdue',
    title: 'Overdue items',
    icon: <DueDateIcon />,
    to: '/contacts',
    feature: 'contacts',
    Component: OverdueWidget,
  },
  {
    id: 'maintenance',
    title: 'Maintenance due',
    icon: <MaintenanceIcon />,
    to: '/inventory',
    feature: 'maintenance',
    Component: MaintenanceWidget,
  },
  {
    id: 'in-transit',
    title: 'In transit',
    icon: <TruckIcon />,
    to: '/inventory',
    feature: 'purchase-orders',
    Component: InTransitWidget,
  },
  {
    id: 'projects',
    title: 'Project statuses',
    icon: <ProjectIcon />,
    to: '/projects',
    feature: 'projects',
    Component: ProjectsWidget,
  },
  {
    id: 'budget-alerts',
    title: 'Budget alerts',
    icon: <BudgetIcon />,
    to: '/projects',
    // Budgets live inside Projects (no separate flag in v1), so they gate together.
    feature: 'projects',
    Component: BudgetAlertsWidget,
  },
  {
    id: 'recent-activity',
    title: 'Recent activity',
    icon: <HistoryIcon />,
    to: '/activity',
    feature: 'activity',
    Component: RecentActivityWidget,
  },
  // System-status board — app plumbing, meaningful whatever modules are on (no gate).
  { id: 'system-database', title: 'Database', icon: <DatabaseIcon />, Component: DatabaseWidget },
  {
    id: 'system-storage',
    title: 'Storage',
    icon: <StorageIcon />,
    to: '/settings',
    Component: StorageWidget,
  },
  { id: 'system-platform', title: 'Platform', icon: <SecureIcon />, Component: PlatformWidget },
];

/** Stable registry id list — the input to `reconcileLayout`/`defaultLayout`. */
export const DASHBOARD_WIDGET_IDS: readonly string[] = DASHBOARD_WIDGETS.map((w) => w.id);

/** Look up a widget definition by id (the grid renders placements by id). */
export function widgetById(id: string): WidgetDefinition | undefined {
  return DASHBOARD_WIDGETS.find((w) => w.id === id);
}
