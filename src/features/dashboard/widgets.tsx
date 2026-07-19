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
import { useStorageStore, useStoragePersisted } from '@/state/stores/useStorageStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFormatters } from '@/lib/useFormatters';
import { useT, type MessageKey } from '@/features/i18n';
import { resolveSupplyState } from '@/features/inventory/supply-state';
import {
  useExpiringItems,
  useLowStockItems,
  useInTransitLines,
  useDueMaintenance,
} from '@/features/lifecycle';
import { useOpenCheckouts } from '@/features/contacts/contacts';
import { daysOverdue, overdueLabel } from '@/features/contacts/overdue';
import { useOnOrderQtys } from '@/features/purchasing/queries';
import { useProjects, useBudgetAlerts } from '@/features/projects/projects';
import { projectBudgetHealth } from '@/features/projects/budget';
import { useItemCount, useLocations } from '@/features/inventory/queries';
import { useCategories } from '@/features/inventory/categories';
import { useInventoryValue } from '@/features/reports/queries';
import { useActivityFeed } from '@/features/activity/queries';
import { describeHistoryEntry } from '@/features/inventory/history-format';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { IN_TRANSIT_LOCATION_ID } from '@/db/repositories/constants';
import type { FeatureId } from '@/features/modules/feature-registry';
import { nowMs } from '@/lib/clock';

export interface WidgetDefinition {
  readonly id: string;
  /** English widget title — the stable reference; the *displayed* label is `t(titleKey)`. */
  readonly title: string;
  /** i18n key for the displayed widget title (G4); its English value equals {@link title}. */
  readonly titleKey: MessageKey;
  readonly icon: ReactNode;
  /** Optional quick-link target — the whole tile navigates here in view mode. */
  readonly to?: string;
  /**
   * Fires just before the quick-link navigates (mirrors the dashboard hero's Add/Scan
   * quick-actions — see `DashboardActions`). Use this to hand a one-shot intent to the
   * destination screen — e.g. `useInventoryEntry.getState().requestLocation(id)` so the
   * In-Transit tile lands pre-scoped to that location rather than the plain list.
   */
  readonly onLinkClick?: () => void;
  /**
   * When `to` is `/settings`, which Settings rail tab the dialog should land on (the Settings
   * dialog special-cases `to: '/settings'` into a direct `openSettings` call rather than a
   * routed `<Link>` — see `DashboardGrid`). Omit to land on the default first tab.
   */
  readonly settingsTab?: string;
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
  errorMessage,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  tone?: Tone;
  loading?: boolean;
  error?: boolean;
  /** Overrides the default "couldn't load" copy — e.g. the crash fallback's wording. */
  errorMessage?: string;
  children: ReactNode;
}) {
  const t = useT();
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
          <p className="text-xs text-warning">{errorMessage ?? t('dashboard.widget.error')}</p>
        ) : loading ? (
          <WidgetSkeleton />
        ) : (
          children
        )}
      </div>
    </>
  );
}

/**
 * Stand-in for a widget whose *render* crashed (as opposed to whose query failed) — the
 * fallback `DashboardGrid` hands to the per-tile {@link ContainedErrorBoundary} (issue #313).
 *
 * Deliberately the same {@link WidgetShell} the tile would have drawn, so the board keeps its
 * layout and the tile stays identifiable by its own icon and title; only the body is replaced.
 */
export function WidgetCrashFallback({ icon, title }: { icon: ReactNode; title: string }) {
  const t = useT();
  return (
    <WidgetShell icon={icon} title={title} error errorMessage={t('dashboard.widget.crashed')}>
      {null}
    </WidgetShell>
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

function WidgetRow({ label, meta, dim = false }: { label: string; meta?: ReactNode; dim?: boolean }) {
  return (
    // `dim` fades a row that's genuinely handled (e.g. a low item fully covered by incoming
    // stock) so it stays listed but reads as less urgent than the rows still needing action.
    <div className={cn('flex items-center justify-between gap-2 text-xs', dim && 'opacity-55')}>
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
  const t = useT();
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const lowStock = useLowStockItems({ qtyThreshold, gaugePercent });
  const rows = lowStock.data?.rows ?? [];
  const defaults = { qtyThreshold, gaugePercent };
  // Batch the on-order lookups for the whole visible low-stock set in one round-trip (not
  // N+1) — mirrors how the widget already batches its item reads. A covered shortage then
  // reads as "handled" rather than "urgent". The low-stock *threshold* is untouched: an
  // item stays flagged (and counted) on its on-hand quantity even when fully on order.
  const onOrder = useOnOrderQtys(rows.map((item) => item.id));
  const onOrderById = onOrder.data;
  return (
    <WidgetShell
      icon={<LowStockIcon />}
      title={t('dashboard.widget.lowStock.title')}
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={lowStock.isPending}
      error={lowStock.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.lowStock.empty')}</EmptyRow>
      ) : (
        rows.slice(0, 3).map((item) => {
          // The row's supply picture in one call (issue #88): the suggested top-up (its own
          // reorder quantity, else the shortfall back up to its effective reorder point), how
          // much is already inbound, and whether that inbound stock fully covers the top-up —
          // a covered row is de-emphasised, since the shortage is already being dealt with.
          const {
            suggestedQty: toReorder,
            onOrderQty,
            covered,
          } = resolveSupplyState({ item, defaults, onOrderQty: onOrderById?.get(item.id) ?? 0 });
          const stockMeta = item.gauge
            ? `${Math.round(item.gauge.percentageRemaining)}%`
            : toReorder > 0
              ? `×${item.quantity} · reorder ${toReorder}`
              : `×${item.quantity}`;
          return (
            <WidgetRow
              key={item.id}
              label={item.name}
              dim={covered}
              meta={
                onOrderQty > 0 ? (
                  <span className="flex items-center gap-2">
                    <span>{stockMeta}</span>
                    <OnOrderTag qty={onOrderQty} />
                  </span>
                ) : (
                  stockMeta
                )
              }
            />
          );
        })
      )}
    </WidgetShell>
  );
}

/**
 * Unobtrusive "N on order" affordance — the TruckIcon + count used on the Reorder tab,
 * reused here so a low item with incoming stock signals the shortage is already being
 * handled. Decorative icon is hidden from assistive tech; the count text carries the meaning.
 */
function OnOrderTag({ qty }: { qty: number }) {
  const t = useT();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-primary [&_svg]:size-3"
      data-testid="low-stock-on-order"
    >
      <TruckIcon aria-hidden />
      {t('dashboard.widget.onOrder', { vars: { qty } })}
    </span>
  );
}

function ExpiringWidget() {
  const t = useT();
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);
  const fmt = useFormatters();
  const expiring = useExpiringItems(expirySoonWindowDays);
  const rows = expiring.data?.rows ?? [];
  return (
    <WidgetShell
      icon={<ExpiryIcon />}
      title={t('dashboard.widget.expiring.title')}
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={expiring.isPending}
      error={expiring.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.expiring.empty')}</EmptyRow>
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
  const t = useT();
  const openCheckouts = useOpenCheckouts();
  // One query returns every open loan (see `useOpenCheckouts`); the overdue set is derived from
  // it in a single pass (no per-checkout round-trip), and the count of the remainder still on
  // loan but not yet due drives the quiet "escalation" footer below.
  const now = nowMs();
  const open = openCheckouts.data?.rows ?? [];
  const overdue = open.filter((c) => c.isOverdue);
  const stillOnLoan = open.length - overdue.length;
  return (
    <WidgetShell
      icon={<DueDateIcon />}
      title={t('dashboard.widget.overdue.title')}
      count={overdue.length}
      // Danger tone (and the red count) fires only when something is actually late — a board of
      // merely-open, not-yet-due loans stays quiet, so the escalation reads at a glance.
      tone={overdue.length > 0 ? 'danger' : 'quiet'}
      loading={openCheckouts.isPending}
      error={openCheckouts.isError}
    >
      {overdue.length === 0 ? (
        <EmptyRow>
          {stillOnLoan > 0
            ? t('dashboard.widget.overdue.emptyWithLoans', { vars: { count: stillOnLoan } })
            : t('dashboard.widget.overdue.empty')}
        </EmptyRow>
      ) : (
        <>
          {overdue.slice(0, 3).map((c) => (
            <WidgetRow
              key={c.id}
              label={c.itemName}
              meta={
                <span className="flex items-center gap-2">
                  <span className="truncate">
                    {t('dashboard.widget.overdue.with', { vars: { name: c.borrowerName } })}
                  </span>
                  <DaysOverdueTag days={daysOverdue(c.dueDate ?? now, now)} />
                </span>
              }
            />
          ))}
          {stillOnLoan > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t('dashboard.widget.overdue.moreOnLoan', { vars: { count: stillOnLoan } })}
            </p>
          ) : null}
        </>
      )}
    </WidgetShell>
  );
}

/**
 * Prominent "N days overdue" affordance — mirrors {@link OnOrderTag}, but in the destructive
 * token so a late loan reads with the same urgency low stock reads its shortfall. Decorative
 * icon is hidden from assistive tech; the label text carries the meaning.
 */
function DaysOverdueTag({ days }: { days: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 font-medium text-destructive [&_svg]:size-3"
      data-testid="overdue-days"
    >
      <DueDateIcon aria-hidden />
      {overdueLabel(days)}
    </span>
  );
}

function MaintenanceWidget() {
  const t = useT();
  const dueMaintenance = useDueMaintenance();
  const rows = dueMaintenance.data?.rows ?? [];
  return (
    <WidgetShell
      icon={<MaintenanceIcon />}
      title={t('dashboard.widget.maintenance.title')}
      count={rows.length}
      tone={rows.length > 0 ? 'warning' : 'quiet'}
      loading={dueMaintenance.isPending}
      error={dueMaintenance.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.maintenance.empty')}</EmptyRow>
      ) : (
        rows.slice(0, 3).map((m) => <WidgetRow key={m.id} label={m.itemName} meta={m.name} />)
      )}
    </WidgetShell>
  );
}

function InTransitWidget() {
  const t = useT();
  const inTransit = useInTransitLines();
  const rows = inTransit.data?.rows ?? [];
  return (
    <WidgetShell
      icon={<TruckIcon />}
      title={t('dashboard.widget.inTransit.title')}
      count={rows.length}
      tone={rows.length > 0 ? 'info' : 'quiet'}
      loading={inTransit.isPending}
      error={inTransit.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.inTransit.empty')}</EmptyRow>
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
  const t = useT();
  const projects = useProjects();
  // Surface the live (non-archived) projects with their lifecycle status (§3).
  const active = (projects.data?.rows ?? []).filter((p) => p.status !== 'ARCHIVED');
  return (
    <WidgetShell
      icon={<ProjectIcon />}
      title={t('dashboard.widget.projects.title')}
      count={active.length}
      tone={active.length > 0 ? 'info' : 'quiet'}
      loading={projects.isPending}
      error={projects.isError}
    >
      {active.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.projects.empty')}</EmptyRow>
      ) : (
        active.slice(0, 3).map((p) => <WidgetRow key={p.id} label={p.name} meta={p.status.toLowerCase()} />)
      )}
    </WidgetShell>
  );
}

function BudgetAlertsWidget() {
  const t = useT();
  const warnPercent = usePreferencesStore((s) => s.budgetWarnPercent);
  const fmt = useFormatters();
  const alerts = useBudgetAlerts();
  // Flag projects whose spend so far (BOM commitments + manual expenses) — or whose
  // projected final cost — is at/over budget. Only budgeted projects are returned, so an
  // empty result simply means everything is on track (§3 "Budget alerts").
  const flagged = (alerts.data ?? [])
    .map((a) => {
      const spentSoFar = a.committedFromBom + a.manualExpenseTotal;
      const { over, warn } = projectBudgetHealth(a, warnPercent);
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
      title={t('dashboard.widget.budget.title')}
      count={flagged.length}
      tone={tone}
      loading={alerts.isPending}
      error={alerts.isError}
    >
      {flagged.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.budget.empty')}</EmptyRow>
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
  const t = useT();
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
    <WidgetShell
      icon={<ValueIcon />}
      title={t('dashboard.widget.totals.title')}
      loading={loading}
      error={error}
    >
      {/* The at-a-glance pulse — its headline figures "count in" from zero on load (and
          roll on any later change). Reduced motion snaps to the final value. */}
      <StatusRow label={t('dashboard.widget.totals.items')}>
        <AnimatedNumber value={totalItems} animateOnMount />
      </StatusRow>
      <StatusRow label={t('dashboard.widget.totals.stockValue')}>
        <Money value={totalValue} formatters={fmt} animate animateOnMount />
      </StatusRow>
      <StatusRow label={t('dashboard.widget.totals.locations')}>
        <AnimatedNumber value={locationCount} animateOnMount />
      </StatusRow>
      <StatusRow label={t('dashboard.widget.totals.categories')}>
        <AnimatedNumber value={categoryCount} animateOnMount />
      </StatusRow>
    </WidgetShell>
  );
}

function RecentActivityWidget() {
  const t = useT();
  // The global activity feed (Phase 80), newest-first — a *continuity* list so the user
  // can pick up what they were last working on, unlike the exception trackers. Reuses the
  // pure describeHistoryEntry seam (Phase 52) for each row's label.
  const feed = useActivityFeed(undefined);
  const rows = (feed.data?.pages.flatMap((p) => p.rows) ?? []).slice(0, 4);
  return (
    <WidgetShell
      icon={<HistoryIcon />}
      title={t('dashboard.widget.recent.title')}
      loading={feed.isPending}
      error={feed.isError}
    >
      {rows.length === 0 ? (
        <EmptyRow>{t('dashboard.widget.recent.empty')}</EmptyRow>
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
  const t = useT();
  const { diagnostics, migration } = useBootResult();
  return (
    <WidgetShell icon={<DatabaseIcon />} title={t('dashboard.widget.database.title')}>
      <StatusRow label={t('dashboard.widget.database.engine')}>SQLite {diagnostics.sqliteVersion}</StatusRow>
      <StatusRow label={t('dashboard.widget.database.vfs')}>{diagnostics.vfs.toUpperCase()}</StatusRow>
      <StatusRow label={t('dashboard.widget.database.fts')}>
        <Pill ok={diagnostics.fts5Available}>
          {diagnostics.fts5Available
            ? t('dashboard.widget.database.ftsYes')
            : t('dashboard.widget.database.ftsNo')}
        </Pill>
      </StatusRow>
      <StatusRow label={t('dashboard.widget.database.schema')}>
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
  const t = useT();
  const persisted = useStoragePersisted();
  const estimate = useStorageStore((state) => state.estimate);
  const ratio = useStorageStore((state) => state.ratio);
  const fmt = useFormatters();
  return (
    <WidgetShell icon={<StorageIcon />} title={t('dashboard.widget.storage.title')}>
      <StatusRow label={t('dashboard.widget.storage.persistence')}>
        <Pill ok={persisted}>
          {persisted ? t('dashboard.widget.storage.persistent') : t('dashboard.widget.storage.ephemeral')}
        </Pill>
      </StatusRow>
      <StatusRow label={t('dashboard.widget.storage.used')}>
        {estimate && estimate.supported
          ? `${fmt.bytes(estimate.usage)} / ${fmt.bytes(estimate.quota)}`
          : t('dashboard.widget.storage.unknown')}
      </StatusRow>
      <StatusRow label={t('dashboard.widget.storage.capacity')}>
        <span className="flex items-center gap-1">
          {estimate && estimate.supported ? fmt.percent(ratio) : '—'}
          <Tooltip content={t('dashboard.widget.storage.capacityHint')} openDelayMs={INFO_OPEN_DELAY_MS}>
            <InfoIcon
              className="size-3 text-muted-foreground/70"
              aria-label={t('dashboard.widget.storage.aboutAria')}
            />
          </Tooltip>
        </span>
      </StatusRow>
      <Tooltip
        content={t('dashboard.widget.storage.manageTooltip')}
        openDelayMs={INFO_OPEN_DELAY_MS}
        triggerTabIndex={-1}
      >
        <p className="mt-1 text-[11px] text-muted-foreground/60">{t('dashboard.widget.storage.manage')}</p>
      </Tooltip>
    </WidgetShell>
  );
}

function PlatformWidget() {
  const t = useT();
  const { diagnostics } = useBootResult();
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const sab = typeof SharedArrayBuffer !== 'undefined';
  return (
    <WidgetShell icon={<SecureIcon />} title={t('dashboard.widget.platform.title')}>
      <StatusRow label={t('dashboard.widget.platform.isolated')}>
        <Pill ok={isolated}>
          {isolated ? t('dashboard.widget.platform.isolatedYes') : t('dashboard.widget.platform.isolatedNo')}
        </Pill>
      </StatusRow>
      <StatusRow label={t('dashboard.widget.platform.sab')}>
        <Pill ok={sab}>
          {sab ? t('dashboard.widget.platform.sabYes') : t('dashboard.widget.platform.sabNo')}
        </Pill>
      </StatusRow>
      <StatusRow label={t('dashboard.widget.platform.dbFile')}>
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
    titleKey: 'dashboard.widget.totals.title',
    icon: <ValueIcon />,
    to: '/reports',
    Component: InventoryTotalsWidget,
  },
  // Low stock is core reorder inventory — always meaningful, so no feature gate.
  {
    id: 'low-stock',
    title: 'Low stock',
    titleKey: 'dashboard.widget.lowStock.title',
    icon: <LowStockIcon />,
    to: '/inventory',
    Component: LowStockWidget,
  },
  {
    id: 'expiring',
    title: 'Soon to expire',
    titleKey: 'dashboard.widget.expiring.title',
    icon: <ExpiryIcon />,
    to: '/inventory',
    feature: 'perishables',
    Component: ExpiringWidget,
  },
  {
    id: 'overdue',
    title: 'Overdue items',
    titleKey: 'dashboard.widget.overdue.title',
    icon: <DueDateIcon />,
    to: '/contacts',
    feature: 'contacts',
    Component: OverdueWidget,
  },
  {
    id: 'maintenance',
    title: 'Maintenance due',
    titleKey: 'dashboard.widget.maintenance.title',
    icon: <MaintenanceIcon />,
    to: '/inventory',
    feature: 'maintenance',
    Component: MaintenanceWidget,
  },
  {
    id: 'in-transit',
    title: 'In transit',
    titleKey: 'dashboard.widget.inTransit.title',
    icon: <TruckIcon />,
    to: '/inventory',
    // Land scoped to the system In-Transit location (spec §4 "liminal procurement") rather
    // than the plain, unfiltered list — that's where incoming stock actually sits.
    onLinkClick: () => useInventoryEntry.getState().requestLocation(IN_TRANSIT_LOCATION_ID),
    feature: 'purchase-orders',
    Component: InTransitWidget,
  },
  {
    id: 'projects',
    title: 'Project statuses',
    titleKey: 'dashboard.widget.projects.title',
    icon: <ProjectIcon />,
    to: '/projects',
    feature: 'projects',
    Component: ProjectsWidget,
  },
  {
    id: 'budget-alerts',
    title: 'Budget alerts',
    titleKey: 'dashboard.widget.budget.title',
    icon: <BudgetIcon />,
    to: '/projects',
    // Budgets live inside Projects (no separate flag in v1), so they gate together.
    feature: 'projects',
    Component: BudgetAlertsWidget,
  },
  {
    id: 'recent-activity',
    title: 'Recent activity',
    titleKey: 'dashboard.widget.recent.title',
    icon: <HistoryIcon />,
    to: '/activity',
    feature: 'activity',
    Component: RecentActivityWidget,
  },
  // System-status board — app plumbing, meaningful whatever modules are on (no gate).
  {
    id: 'system-database',
    title: 'Database',
    titleKey: 'dashboard.widget.database.title',
    icon: <DatabaseIcon />,
    Component: DatabaseWidget,
  },
  {
    id: 'system-storage',
    title: 'Storage',
    titleKey: 'dashboard.widget.storage.title',
    icon: <StorageIcon />,
    to: '/settings',
    // Land on "Data & storage" — the tab holding the manage/erase tools this tile's own
    // "Manage storage & erase data →" copy promises, rather than the default Appearance tab.
    settingsTab: 'storage',
    Component: StorageWidget,
  },
  {
    id: 'system-platform',
    title: 'Platform',
    titleKey: 'dashboard.widget.platform.title',
    icon: <SecureIcon />,
    Component: PlatformWidget,
  },
];

/**
 * Which "attention" cards are currently **all clear** (issue #111) — the exception trackers
 * (low stock, soon to expire, overdue, maintenance due, budget alerts) whose empty state
 * genuinely means "nothing to report". The informational cards (totals, recent activity,
 * projects, in transit, system status) have no problem/clear semantic and so are never probed
 * or hidden.
 *
 * For each tracker this mirrors that widget's own "empty" condition — an id is added only once
 * its query has actually resolved to zero rows, so a card is never hidden while its data is
 * still loading or errored (it stays shown until we can confirm there's nothing to report).
 * react-query dedupes these against the widgets' own subscriptions, so no extra database
 * round-trip is incurred.
 *
 * Only run while "hide healthy cards" is on (the grid mounts the probe conditionally), so the
 * default board pays nothing for it. Keep each branch in step with its matching widget above.
 */
export function useHealthyWidgetIds(): ReadonlySet<string> {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);
  const warnPercent = usePreferencesStore((s) => s.budgetWarnPercent);

  const lowStock = useLowStockItems({ qtyThreshold, gaugePercent });
  const expiring = useExpiringItems(expirySoonWindowDays);
  const openCheckouts = useOpenCheckouts();
  const dueMaintenance = useDueMaintenance();
  const alerts = useBudgetAlerts();

  const healthy = new Set<string>();
  // LowStockWidget: empty when no item is at/below its reorder point.
  if (lowStock.data && lowStock.data.rows.length === 0) healthy.add('low-stock');
  // ExpiringWidget: empty when nothing falls inside the "expiring soon" window.
  if (expiring.data && expiring.data.rows.length === 0) healthy.add('expiring');
  // OverdueWidget: clear when no open loan is actually late (merely-on-loan doesn't count).
  if (openCheckouts.data && openCheckouts.data.rows.every((c) => !c.isOverdue)) healthy.add('overdue');
  // MaintenanceWidget: empty when nothing is due for servicing.
  if (dueMaintenance.data && dueMaintenance.data.rows.length === 0) healthy.add('maintenance');
  // BudgetAlertsWidget: clear when no budgeted project is over or approaching its budget.
  if (alerts.data) {
    const flagged = alerts.data.filter((a) => {
      const { over, warn } = projectBudgetHealth(a, warnPercent);
      return over || warn;
    });
    if (flagged.length === 0) healthy.add('budget-alerts');
  }
  return healthy;
}

/** Stable registry id list — the input to `reconcileLayout`/`defaultLayout`. */
export const DASHBOARD_WIDGET_IDS: readonly string[] = DASHBOARD_WIDGETS.map((w) => w.id);

/** Look up a widget definition by id (the grid renders placements by id). */
export function widgetById(id: string): WidgetDefinition | undefined {
  return DASHBOARD_WIDGETS.find((w) => w.id === id);
}
