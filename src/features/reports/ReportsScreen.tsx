import { useEffect, useRef, useState } from 'react';
import { Button, LiveRegion, PageHeader, Spinner, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  ExportIcon,
  LowStockIcon,
  ReportIcon,
} from '@/components/icons';
import { ExportWizard } from '@/features/export/ExportWizard';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { ValueBreakdown } from './components/ValueBreakdown';
import { MovementChart } from './components/MovementChart';
import { AbcBreakdown } from './components/AbcBreakdown';
import { TurnoverTable } from './components/TurnoverTable';
import { StockAgingChart } from './components/StockAgingChart';
import { ValuationSparkline } from './components/ValuationSparkline';
import { HygieneChecklist } from './components/HygieneChecklist';
import { SpendBreakdown } from './components/SpendBreakdown';
import {
  ABC_WINDOW_DAYS,
  ANALYTICS_WINDOWS,
  DEAD_STOCK_SINCE_DAYS,
  DEFAULT_ANALYTICS_WINDOW,
  REPORT_WINDOW_DAYS,
  useAbcAnalysis,
  useConsumptionRate,
  useDataHygiene,
  useDeadStock,
  useInventoryValue,
  useLowStockCount,
  useMovement,
  useSpendAnalytics,
  useStockAging,
  useTurnover,
  useValuationTrend,
} from './queries';

/**
 * The §3 Reports & valuation screen (inventory-depth Phase 61): headline value cards, a
 * category/location valuation breakdown, the consumption rate and a stock-movement chart,
 * and low-stock & dead-stock rollups — all read-only projections over data already stored.
 * Visuals are composed with Tailwind/SVG and design tokens (no chart dependency, §2.4.3).
 * CSV export is offered through the shared Export Wizard (Report CSV format).
 */
export function ReportsScreen() {
  const f = useFormatters();
  const [exportOpen, setExportOpen] = useState(false);
  // Selectable trailing window driving the turnover + valuation-trend analytics (ABC stays annual).
  const [analyticsWindow, setAnalyticsWindow] = useState<number>(DEFAULT_ANALYTICS_WINDOW);

  const value = useInventoryValue();
  const consumption = useConsumptionRate();
  const movement = useMovement();
  const lowStock = useLowStockCount();
  const deadStock = useDeadStock();

  // Phase 74 advanced analytics.
  const abc = useAbcAnalysis();
  const turnover = useTurnover(analyticsWindow);
  const aging = useStockAging();
  const trend = useValuationTrend(analyticsWindow);

  // Phase 77 data-hygiene / quality report.
  const hygiene = useDataHygiene();

  // Phase 79 procurement / spend analytics — its own selectable trailing window.
  const [spendWindow, setSpendWindow] = useState<number>(DEFAULT_ANALYTICS_WINDOW);
  const spend = useSpendAnalytics(spendWindow);

  // Derive aggregate loading / error state from all five queries.
  const isAnyLoading =
    value.isLoading || consumption.isLoading || movement.isLoading ||
    lowStock.isLoading || deadStock.isLoading;
  const isAnyError =
    value.isError || consumption.isError || movement.isError ||
    lowStock.isError || deadStock.isError;

  // Announce the ready / error transition ONCE via the always-mounted live region.
  // Tracked with a ref so re-renders (e.g. React Strict Mode double-invoke) don't
  // re-fire the announcement after it has already been set.
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef(false);
  useEffect(() => {
    if (isAnyLoading || announcedRef.current) return;
    announcedRef.current = true;
    if (isAnyError) {
      setAnnouncement('Reports failed to load.');
    } else {
      const total = value.data ? ` — inventory value ${f.currency(value.data.totalValue)}` : '';
      setAnnouncement(`Reports ready${total}.`);
    }
  }, [isAnyLoading, isAnyError, value.data, f]);

  // The advanced-analytics block has its own once-only completion announcement (Phase 63 /
  // WCAG 4.1.3), separate from the headline reports above so each section reports its own
  // readiness. Tracked with its own ref so re-renders (and the window-toggle re-fetch) don't
  // re-fire it once it has resolved.
  const isAnalyticsLoading = abc.isLoading || turnover.isLoading || aging.isLoading || trend.isLoading;
  const isAnalyticsError = abc.isError || turnover.isError || aging.isError || trend.isError;
  const [analyticsAnnouncement, setAnalyticsAnnouncement] = useState('');
  const analyticsAnnouncedRef = useRef(false);
  useEffect(() => {
    if (isAnalyticsLoading || analyticsAnnouncedRef.current) return;
    analyticsAnnouncedRef.current = true;
    setAnalyticsAnnouncement(isAnalyticsError ? 'Analytics failed to load.' : 'Analytics ready.');
  }, [isAnalyticsLoading, isAnalyticsError]);

  // The data-hygiene block's own once-only completion announcement (Phase 63 / WCAG 4.1.3).
  const [hygieneAnnouncement, setHygieneAnnouncement] = useState('');
  const hygieneAnnouncedRef = useRef(false);
  useEffect(() => {
    if (hygiene.isLoading || hygieneAnnouncedRef.current) return;
    hygieneAnnouncedRef.current = true;
    if (hygiene.isError) {
      setHygieneAnnouncement('Data hygiene report failed to load.');
    } else {
      const flagged = hygiene.data?.flaggedItems ?? 0;
      setHygieneAnnouncement(
        flagged === 0
          ? 'Data hygiene ready — nothing needs tidying.'
          : `Data hygiene ready — ${flagged} item${flagged === 1 ? '' : 's'} need attention.`,
      );
    }
  }, [hygiene.isLoading, hygiene.isError, hygiene.data]);

  // The spend-analytics block's own once-only completion announcement (Phase 63 / WCAG 4.1.3).
  const [spendAnnouncement, setSpendAnnouncement] = useState('');
  const spendAnnouncedRef = useRef(false);
  useEffect(() => {
    if (spend.isLoading || spendAnnouncedRef.current) return;
    spendAnnouncedRef.current = true;
    setSpendAnnouncement(
      spend.isError
        ? 'Spend analytics failed to load.'
        : `Spend analytics ready — ${f.currency(spend.data?.total ?? 0)} in the window.`,
    );
  }, [spend.isLoading, spend.isError, spend.data, f]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <PageHeader
        icon={<ReportIcon />}
        title="Reports & valuation"
        actions={
          <Button variant="outline" onClick={() => setExportOpen(true)} data-testid="open-report-export">
            <ExportIcon />
            Export CSV
          </Button>
        }
      />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col gap-6 outline-none">
        {/* Headline value cards */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Inventory value"
            testId="stat-total-value"
            loading={value.isLoading}
            value={value.data ? f.currency(value.data.totalValue) : '—'}
            sub={value.data ? `${f.quantity(value.data.totalQuantity)} units` : undefined}
          />
          <StatCard
            label={`Consumption (${REPORT_WINDOW_DAYS}d)`}
            testId="stat-consumption"
            loading={consumption.isLoading}
            value={consumption.data ? `${f.quantity(Math.round(consumption.data.perDay * 10) / 10)}/day` : '—'}
            sub={consumption.data ? `${f.quantity(consumption.data.totalConsumed)} total` : undefined}
          />
          <StatCard
            label="Low stock"
            testId="stat-low-stock"
            loading={lowStock.isLoading}
            value={lowStock.data != null ? f.quantity(lowStock.data) : '—'}
            sub="items at/below threshold"
            tone={lowStock.data && lowStock.data > 0 ? 'warning' : undefined}
            icon={<LowStockIcon />}
          />
          <StatCard
            label={`Dead stock (${DEAD_STOCK_SINCE_DAYS}d)`}
            testId="stat-dead-stock"
            loading={deadStock.isLoading}
            value={deadStock.data ? f.currency(deadStock.data.totalValue) : '—'}
            sub={deadStock.data ? `${f.quantity(deadStock.data.lines.length)} idle items` : undefined}
          />
        </section>

        {/* Valuation breakdown */}
        <section className="grid gap-6 lg:grid-cols-2">
          <Panel title="Value by category">
            {value.isLoading ? (
              <CentredSpinner />
            ) : (
              <ValueBreakdown groups={value.data?.byCategory ?? []} formatters={f} emptyLabel="No priced stock yet." />
            )}
          </Panel>
          <Panel title="Value by location">
            {value.isLoading ? (
              <CentredSpinner />
            ) : (
              <ValueBreakdown groups={value.data?.byLocation ?? []} formatters={f} emptyLabel="No priced stock yet." />
            )}
          </Panel>
        </section>

        {/* Stock movement */}
        <Panel title={`Stock movement (last ${REPORT_WINDOW_DAYS} days)`}>
          {movement.isLoading ? (
            <CentredSpinner />
          ) : movement.data ? (
            <MovementChart report={movement.data} formatters={f} />
          ) : null}
        </Panel>

        {/* Dead stock */}
        <Panel title={`Dead stock — no movement in ${DEAD_STOCK_SINCE_DAYS} days`}>
          {deadStock.isLoading ? (
            <CentredSpinner />
          ) : deadStock.data && deadStock.data.lines.length > 0 ? (
            <ul className="divide-y divide-border" data-testid="dead-stock-list">
              {deadStock.data.lines.slice(0, 20).map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-medium">{line.name}</span>
                  <span className="flex shrink-0 items-center gap-4 text-muted-foreground">
                    <span>{f.quantity(line.quantity)} units</span>
                    <span>{line.idleDays}d idle</span>
                    <span className="font-medium text-foreground">{f.currency(line.value)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing idle — all stock has moved recently.
            </p>
          )}
        </Panel>

        {/* Advanced analytics (Phase 74) — ABC, turnover, stock aging & valuation over time. */}
        <section className="flex flex-col gap-6" aria-labelledby="analytics-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="analytics-heading" className="text-base font-semibold tracking-tight">
              Advanced analytics
            </h2>
            <WindowToggle value={analyticsWindow} onChange={setAnalyticsWindow} formatters={f} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={`ABC analysis (annual consumption, ${ABC_WINDOW_DAYS}d)`}>
              {abc.isLoading ? (
                <CentredSpinner />
              ) : abc.data ? (
                <AbcBreakdown report={abc.data} formatters={f} emptyLabel="No consumption recorded yet." />
              ) : null}
            </Panel>

            <Panel title={`Inventory turnover (last ${analyticsWindow} days)`}>
              {turnover.isLoading ? (
                <CentredSpinner />
              ) : turnover.data ? (
                <TurnoverTable report={turnover.data} formatters={f} />
              ) : null}
            </Panel>

            <Panel title="Stock aging">
              {aging.isLoading ? (
                <CentredSpinner />
              ) : aging.data ? (
                <StockAgingChart report={aging.data} formatters={f} />
              ) : null}
            </Panel>

            <Panel title={`Valuation over time (last ${analyticsWindow} days)`}>
              {trend.isLoading ? (
                <CentredSpinner />
              ) : trend.data ? (
                <ValuationSparkline report={trend.data} formatters={f} />
              ) : null}
            </Panel>
          </div>
        </section>

        {/* Data hygiene (Phase 77) — a "tidy up" checklist of records needing attention. */}
        <section className="flex flex-col gap-3" aria-labelledby="hygiene-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="hygiene-heading" className="text-base font-semibold tracking-tight">
              Data hygiene
            </h2>
            {hygiene.data ? (
              <p className="text-sm text-muted-foreground" data-testid="hygiene-summary">
                {hygiene.data.flaggedItems === 0
                  ? `All ${f.quantity(hygiene.data.totalItems)} items look tidy.`
                  : `${f.quantity(hygiene.data.flaggedItems)} of ${f.quantity(hygiene.data.totalItems)} items need attention.`}
              </p>
            ) : null}
          </div>
          <Panel title="Quality checks">
            {hygiene.isLoading ? (
              <CentredSpinner />
            ) : hygiene.data ? (
              <HygieneChecklist report={hygiene.data} formatters={f} />
            ) : (
              <p className="py-6 text-center text-sm text-destructive">
                The data hygiene report failed to load.
              </p>
            )}
          </Panel>
        </section>

        {/* Spend analytics (Phase 79) — money OUT over time, by source/supplier/category.
            Distinct from the valuation trend above (inventory value). */}
        <section className="flex flex-col gap-3" aria-labelledby="spend-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="spend-heading" className="text-base font-semibold tracking-tight">
              Spend analytics
            </h2>
            <WindowToggle value={spendWindow} onChange={setSpendWindow} formatters={f} label="Spend window" />
          </div>
          <p className="text-sm text-muted-foreground">
            Cash out from received purchase orders, project expenses and asset acquisitions. An item
            bought through a purchase order may also carry an acquisition price, so sources can overlap.
          </p>
          <Panel title={`Spend (last ${spendWindow} days)`}>
            {spend.isLoading ? (
              <CentredSpinner />
            ) : spend.data ? (
              <SpendBreakdown report={spend.data} formatters={f} />
            ) : (
              <p className="py-6 text-center text-sm text-destructive">
                The spend analytics report failed to load.
              </p>
            )}
          </Panel>
        </section>
      </main>

      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Pre-mounted announce-only regions; content mutates once reports resolve so the
          transition from "Loading…" to resolved values is announced to assistive tech
          (WCAG 4.1.3). Two regions so polite "ready" and assertive "error" are always
          mounted — switching role on a single region breaks screen-reader registration. */}
      <LiveRegion visuallyHidden data-testid="reports-live-region">
        {!isAnyError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="reports-error-live-region">
        {isAnyError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>

      {/* The advanced-analytics block's own once-only completion region (Phase 74). */}
      <LiveRegion visuallyHidden data-testid="analytics-live-region">
        {!isAnalyticsError && analyticsAnnouncement ? <p>{analyticsAnnouncement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="analytics-error-live-region">
        {isAnalyticsError && analyticsAnnouncement ? <p>{analyticsAnnouncement}</p> : null}
      </LiveRegion>

      {/* The data-hygiene block's own once-only completion region (Phase 77). */}
      <LiveRegion visuallyHidden data-testid="hygiene-live-region">
        {!hygiene.isError && hygieneAnnouncement ? <p>{hygieneAnnouncement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="hygiene-error-live-region">
        {hygiene.isError && hygieneAnnouncement ? <p>{hygieneAnnouncement}</p> : null}
      </LiveRegion>

      {/* The spend-analytics block's own once-only completion region (Phase 79). */}
      <LiveRegion visuallyHidden data-testid="spend-live-region">
        {!spend.isError && spendAnnouncement ? <p>{spendAnnouncement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="spend-error-live-region">
        {spend.isError && spendAnnouncement ? <p>{spendAnnouncement}</p> : null}
      </LiveRegion>
    </div>
  );
}

/**
 * A small segmented control selecting the trailing window (days) for the turnover + valuation
 * analytics. Tokens only; the active option uses the `primary` surface, the rest are muted.
 */
function WindowToggle({
  value,
  onChange,
  formatters,
  label = 'Analytics window',
}: {
  value: number;
  onChange: (days: number) => void;
  formatters: Formatters;
  label?: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg bg-secondary/60 p-0.5"
      role="group"
      aria-label={label}
    >
      {ANALYTICS_WINDOWS.map((days) => {
        const active = days === value;
        return (
          <button
            key={days}
            type="button"
            onClick={() => onChange(days)}
            aria-pressed={active}
            className={`rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {formatters.quantity(days)}d
          </button>
        );
      })}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  loading,
  tone,
  icon,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  loading?: boolean;
  tone?: 'warning';
  icon?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Surface className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      {loading ? (
        <Spinner />
      ) : (
        <span
          className={`text-2xl font-semibold tracking-tight ${tone === 'warning' ? 'text-warning' : 'text-foreground'}`}
          data-testid={testId}
        >
          {value}
        </span>
      )}
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </Surface>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Surface className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Surface>
  );
}

function CentredSpinner() {
  return (
    <div className="flex justify-center py-8">
      <Spinner />
    </div>
  );
}
