import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AnimatedNumber,
  Button,
  COUNT_UP_HEADLINE_DURATION_MS,
  buttonVariants,
  LiveRegion,
  Money,
  PageContainer,
  PageHeader,
  Reveal,
  Spinner,
  Surface,
  MAIN_CONTENT_ID,
  useInViewport,
} from '@/components/foundry';
import {
  CatalogueIcon,
  ExportIcon,
  InsuranceScheduleIcon,
  LowStockIcon,
  ReportIcon,
} from '@/components/icons';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ExportWizard } from '@/features/export/ExportWizard';
import type { Formatters } from '@/lib/format';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { ValueBreakdown } from './components/ValueBreakdown';
import { DeadStockList } from './components/DeadStockList';
import { ConsumptionBreakdown } from './components/ConsumptionBreakdown';
import { formatConsumed } from './components/consumption-format';
import { MovementChart } from './components/MovementChart';
import { AbcBreakdown } from './components/AbcBreakdown';
import { TurnoverTable } from './components/TurnoverTable';
import { StockAgingChart } from './components/StockAgingChart';
import { ValuationSparkline } from './components/ValuationSparkline';
import { HygieneChecklist } from './components/HygieneChecklist';
import { SpendBreakdown } from './components/SpendBreakdown';
import { SalesBreakdown } from './components/SalesBreakdown';
import {
  ABC_WINDOW_DAYS,
  ANALYTICS_WINDOWS,
  DATA_HYGIENE_STALE_DAYS,
  normaliseAnalyticsWindow,
  REPORT_MOVEMENT_BUCKETS,
  REPORT_WINDOW_DAYS,
  useAbcAnalysis,
  useConsumptionRate,
  useDataHygiene,
  useDeadStock,
  useForeignCurrencyCostCount,
  useInventoryValue,
  useLowStockCount,
  useMovement,
  useSalesAnalytics,
  useSpendAnalytics,
  useStockAging,
  useTurnover,
  useValuationTrend,
} from './queries';
import { usePermission } from '@/features/users/usePermission';
import { ForeignCurrencyNotice } from './components/ForeignCurrencyNotice';
import type { HygieneIssueKind } from './data-hygiene';

/** Module-level so the omission list is referentially stable across renders (it is in a query key). */
const WITHOUT_NEVER_COUNTED: readonly HygieneIssueKind[] = ['never-counted'];

/**
 * The §3 Reports & valuation screen (inventory-depth Phase 61): headline value cards, a
 * category/location valuation breakdown, the consumption rate and a stock-movement chart,
 * and low-stock & dead-stock rollups — all read-only projections over data already stored.
 * Visuals are composed with Tailwind/SVG and design tokens (no chart dependency, §2.4.3).
 * CSV export is offered through the shared Export Wizard (Report CSV format).
 */
export function ReportsScreen() {
  const f = useFormatters();
  const t = useT();
  const [exportOpen, setExportOpen] = useState(false);
  // The other entry point to the export wizard is the Inventory screen, which is gated on the
  // same key. Leaving this one open let a role without `export:run` walk the whole wizard and
  // meet the refusal only when `runExport` finally read the data (issue #429).
  const mayExport = usePermission('export:run');
  // Selectable trailing window driving the turnover + valuation-trend analytics (ABC stays annual).
  // Persisted per-section (issue #116) so each remembers its own window across reloads; normalised
  // on read so a stale persisted value can never reach a query key or the segmented control.
  const analyticsWindow = normaliseAnalyticsWindow(usePreferencesStore((s) => s.reportsAnalyticsWindow));
  const setAnalyticsWindow = usePreferencesStore((s) => s.setReportsAnalyticsWindow);

  // Below-the-fold reports are gated on their panel actually being on screen (issue #528).
  //
  // The screen is long — a reader lands on the headline cards and sees maybe the first panel —
  // yet every report used to run on mount, six of them a pass over the whole catalogue, and
  // every item write re-ran the lot for as long as the screen stayed open. The gate fixes both
  // halves with one signal: a panel nobody has scrolled to neither fetches on mount nor
  // refetches when `invalidateItems` marks it stale, and it picks the new figures up the moment
  // it is scrolled into view. Nothing about *correctness* moves — the reader still never reads
  // a figure that a write has since changed; the work simply happens when they look.
  //
  // Without an IntersectionObserver every gate reports `true`, so the screen fetches exactly as
  // it did before. That fallback is not what the unit suite exercises, though: happy-dom defines
  // the constructor but never delivers an entry, so `ReportsScreen.test.tsx` stubs a working one.
  //
  // The headline cards deliberately have no gate: they are above the fold by definition, and
  // three of them (value, consumption, dead stock) also feed a panel further down.
  const movementView = useInViewport();
  const analyticsView = useInViewport();
  const hygieneView = useInViewport();
  const spendView = useInViewport();
  const salesView = useInViewport();

  const value = useInventoryValue();
  // Stock the valuation queries had to leave out because its price is quoted in another
  // currency — surfaced beneath the headline cards so the totals are never quietly short (#284).
  const excludedByCurrency = useForeignCurrencyCostCount();
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  const consumption = useConsumptionRate();
  // The consumption report is one line per unit of measure and carries no overall total (issue
  // #685): grams, millilitres and screws are not addable. The headline tile therefore shows the
  // largest single unit — the lines are ordered biggest-first — and counts the rest.
  const leadConsumption = consumption.data?.lines[0];
  const otherConsumptionUnits = Math.max(0, (consumption.data?.lines.length ?? 0) - 1);
  // The tile's sub-label: the leading unit's total, saying how many other units are not in it —
  // or, once the report has loaded with nothing in it, that nothing was consumed at all.
  const consumptionSub = leadConsumption
    ? t(otherConsumptionUnits > 0 ? 'reports.consumption.totalWithMore' : 'reports.consumption.total', {
        vars: {
          amount: formatConsumed(leadConsumption.totalConsumed, leadConsumption.unit, f, t),
          count: otherConsumptionUnits,
        },
      })
    : consumption.data
      ? t('reports.consumption.none')
      : undefined;
  // Stock movement has its own selectable window (issue #86), matching the Spend and Sales
  // sections rather than the fixed 30-day span it used to be pinned to.
  const movementWindow = normaliseAnalyticsWindow(usePreferencesStore((s) => s.reportsMovementWindow));
  const setMovementWindow = usePreferencesStore((s) => s.setReportsMovementWindow);
  const movement = useMovement(movementWindow, REPORT_MOVEMENT_BUCKETS, {
    enabled: movementView.inView,
  });
  const lowStock = useLowStockCount();
  // The global idle threshold (issue #92) — the figure the panel is labelled with, and the
  // fallback for items whose location doesn't override it.
  const deadStockDays = usePreferencesStore((s) => s.deadStockDays);
  const deadStock = useDeadStock();

  // Phase 74 advanced analytics.
  // All four share one gate: they are laid out as a single block, so any of them being on
  // screen means the reader is looking at the section.
  const analyticsInView = analyticsView.inView;
  const abc = useAbcAnalysis({ enabled: analyticsInView });
  const turnover = useTurnover(analyticsWindow, { enabled: analyticsInView });
  const aging = useStockAging({ enabled: analyticsInView });
  const trend = useValuationTrend(analyticsWindow, { enabled: analyticsInView });

  // Phase 77 data-hygiene / quality report.
  //
  // Modular UI: with the Cycle-counts module off there is no stock-take to run, so the "Never
  // counted" check would flag every item for something the user cannot clear. The check is
  // omitted at source rather than filtered out of the built report, so the "N of M items need
  // attention" headline keeps agreeing with the rows below it.
  const cycleCountsOn = useEnabledFeatures().has('cycle-counts');
  const hygiene = useDataHygiene(DATA_HYGIENE_STALE_DAYS, {
    enabled: hygieneView.inView,
    omitKinds: cycleCountsOn ? undefined : WITHOUT_NEVER_COUNTED,
  });

  // Phase 79 procurement / spend analytics — its own selectable trailing window.
  //
  // Modular UI (Phase 7): the spend card is dropped when the Purchase-orders module is off —
  // its money-out sources are procurement-led (received POs, plus project expenses and asset
  // acquisitions), so it belongs to that module. Skip the fetch (`enabled`) rather than
  // fetch-then-hide, and omit the whole section + its live regions below.
  const spendOn = useEnabledFeatures().has('purchase-orders');
  const spendWindow = normaliseAnalyticsWindow(usePreferencesStore((s) => s.reportsSpendWindow));
  const setSpendWindow = usePreferencesStore((s) => s.setReportsSpendWindow);
  const spend = useSpendAnalytics(spendWindow, { enabled: spendOn && spendView.inView });

  // Sales & disposals analytics — its own selectable window; dropped when the Sales module is off.
  const salesOn = useEnabledFeatures().has('sales');
  const salesWindow = normaliseAnalyticsWindow(usePreferencesStore((s) => s.reportsSalesWindow));
  const setSalesWindow = usePreferencesStore((s) => s.setReportsSalesWindow);
  const sales = useSalesAnalytics(salesWindow, { enabled: salesOn && salesView.inView });

  // Derive aggregate loading / error state from the ungated headline queries.
  //
  // Stock movement used to be counted here; it now sits behind its own viewport gate, so a
  // reader who never scrolls to it would otherwise hold the "Reports ready" announcement open
  // forever waiting for a query that is deliberately idle. The movement panel carries its own
  // spinner and its own failure message instead, like the gated sections below it.
  const isAnyLoading = value.isLoading || consumption.isLoading || lowStock.isLoading || deadStock.isLoading;
  const isAnyError = value.isError || consumption.isError || lowStock.isError || deadStock.isError;

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
    // An idle query is not a loading one, so the gate has to be part of the guard: without it
    // the section would announce "Analytics ready" before it had fetched anything at all.
    if (!analyticsInView || isAnalyticsLoading || analyticsAnnouncedRef.current) return;
    analyticsAnnouncedRef.current = true;
    setAnalyticsAnnouncement(isAnalyticsError ? 'Analytics failed to load.' : 'Analytics ready.');
  }, [analyticsInView, isAnalyticsLoading, isAnalyticsError]);

  // The data-hygiene block's own once-only completion announcement (Phase 63 / WCAG 4.1.3).
  const [hygieneAnnouncement, setHygieneAnnouncement] = useState('');
  const hygieneAnnouncedRef = useRef(false);
  useEffect(() => {
    // Gated like the analytics announcement above — an idle query must not announce "ready".
    if (!hygieneView.inView || hygiene.isLoading || hygieneAnnouncedRef.current) return;
    hygieneAnnouncedRef.current = true;
    if (hygiene.isError) {
      setHygieneAnnouncement('Data hygiene report failed to load.');
    } else {
      const flagged = hygiene.data?.flaggedItems ?? 0;
      setHygieneAnnouncement(
        flagged === 0
          ? 'Data hygiene ready — nothing needs tidying.'
          : `Data hygiene ready — ${flagged} ${plural(flagged, 'item')} need attention.`,
      );
    }
  }, [hygieneView.inView, hygiene.isLoading, hygiene.isError, hygiene.data]);

  // The spend-analytics block's own once-only completion announcement (Phase 63 / WCAG 4.1.3).
  const [spendAnnouncement, setSpendAnnouncement] = useState('');
  const spendAnnouncedRef = useRef(false);
  useEffect(() => {
    // Skip the announcement entirely while the spend query is idle — because the module is
    // off, or because the section has not been scrolled to yet.
    if (!spendOn || !spendView.inView || spend.isLoading || spendAnnouncedRef.current) return;
    spendAnnouncedRef.current = true;
    setSpendAnnouncement(
      spend.isError
        ? 'Spend analytics failed to load.'
        : `Spend analytics ready — ${f.currency(spend.data?.total ?? 0)} in the window.`,
    );
  }, [spendOn, spendView.inView, spend.isLoading, spend.isError, spend.data, f]);

  // The sales-analytics block's own once-only completion announcement (WCAG 4.1.3).
  const [salesAnnouncement, setSalesAnnouncement] = useState('');
  const salesAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!salesOn || !salesView.inView || sales.isLoading || salesAnnouncedRef.current) return;
    salesAnnouncedRef.current = true;
    setSalesAnnouncement(
      sales.isError
        ? 'Sales analytics failed to load.'
        : `Sales analytics ready — ${f.currency(sales.data?.proceeds ?? 0)} in proceeds.`,
    );
  }, [salesOn, salesView.inView, sales.isLoading, sales.isError, sales.data, f]);

  return (
    <PageContainer>
      <PageHeader
        icon={<ReportIcon />}
        title="Reports & valuation"
        actions={
          <>
            <Link
              to="/catalogue"
              className={buttonVariants({ variant: 'outline' })}
              data-testid="open-catalogue"
            >
              <CatalogueIcon />
              Catalogue
            </Link>
            <Link
              to="/insurance-schedule"
              className={buttonVariants({ variant: 'outline' })}
              data-testid="open-insurance-schedule"
            >
              <InsuranceScheduleIcon />
              Insurance schedule
            </Link>
            {mayExport ? (
              <Button variant="outline" onClick={() => setExportOpen(true)} data-testid="open-report-export">
                <ExportIcon />
                Export CSV
              </Button>
            ) : null}
          </>
        }
      />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/* Headline value cards — each scroll-reveals with a gentle left-to-right stagger (F3),
            then counts in over the long headline roll so the figure visibly settles (issue #448). */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Reveal index={0} className="h-full">
            <StatCard
              label="Inventory value"
              testId="stat-total-value"
              loading={value.isLoading}
              value={
                value.data ? (
                  <Money
                    value={value.data.totalValue}
                    formatters={f}
                    animate
                    animateOnMount
                    durationMs={COUNT_UP_HEADLINE_DURATION_MS}
                  />
                ) : (
                  '—'
                )
              }
              sub={value.data ? `${f.quantity(value.data.totalQuantity)} units` : undefined}
            />
          </Reveal>
          <Reveal index={1} className="h-full">
            {/* The tile shows the single most-consumed unit of measure, labelled with that unit,
                and says how many others there are — consumption is never one figure (issue #685),
                so the whole per-unit picture lives in its own panel below. */}
            <StatCard
              label={`Consumption (${REPORT_WINDOW_DAYS}d)`}
              testId="stat-consumption"
              loading={consumption.isLoading}
              value={
                leadConsumption ? (
                  <AnimatedNumber
                    value={leadConsumption.perDay}
                    format={(n) =>
                      t('reports.consumption.rate', {
                        vars: { amount: formatConsumed(n, leadConsumption.unit, f, t) },
                      })
                    }
                    durationMs={COUNT_UP_HEADLINE_DURATION_MS}
                    animateOnMount
                  />
                ) : (
                  '—'
                )
              }
              sub={consumptionSub}
            />
          </Reveal>
          <Reveal index={2} className="h-full">
            <StatCard
              label="Low stock"
              testId="stat-low-stock"
              loading={lowStock.isLoading}
              value={
                lowStock.data != null ? (
                  <AnimatedNumber
                    value={lowStock.data}
                    format={(n) => f.quantity(Math.round(n))}
                    durationMs={COUNT_UP_HEADLINE_DURATION_MS}
                    animateOnMount
                  />
                ) : (
                  '—'
                )
              }
              sub="items at/below threshold"
              tone={lowStock.data && lowStock.data > 0 ? 'warning' : undefined}
              icon={<LowStockIcon />}
            />
          </Reveal>
          <Reveal index={3} className="h-full">
            <StatCard
              label={`Dead stock (${deadStockDays}d)`}
              testId="stat-dead-stock"
              loading={deadStock.isLoading}
              value={
                deadStock.data ? (
                  <Money
                    value={deadStock.data.totalValue}
                    formatters={f}
                    animate
                    animateOnMount
                    durationMs={COUNT_UP_HEADLINE_DURATION_MS}
                  />
                ) : (
                  '—'
                )
              }
              sub={deadStock.data ? `${f.quantity(deadStock.data.lines.length)} idle items` : undefined}
            />
          </Reveal>
        </section>

        <ForeignCurrencyNotice count={excludedByCurrency.data} baseCurrency={baseCurrency} />

        {/* Valuation breakdown */}
        <Reveal as="section" className="grid gap-6 lg:grid-cols-2">
          <Panel title="Value by category">
            {value.isLoading ? (
              <CentredSpinner />
            ) : (
              <ValueBreakdown
                groups={value.data?.byCategory ?? []}
                formatters={f}
                label={t('common.rows.categories')}
                emptyLabel="No priced stock yet."
              />
            )}
          </Panel>
          <Panel title="Value by location">
            {value.isLoading ? (
              <CentredSpinner />
            ) : (
              <ValueBreakdown
                groups={value.data?.byLocation ?? []}
                formatters={f}
                label={t('common.rows.locations')}
                emptyLabel="No priced stock yet."
              />
            )}
          </Panel>
        </Reveal>

        {/* Consumption, one row per unit of measure (issue #685) */}
        <Reveal>
          <Panel title={t('reports.consumption.panelTitle', { vars: { days: REPORT_WINDOW_DAYS } })}>
            {consumption.isLoading ? (
              <CentredSpinner />
            ) : consumption.data ? (
              <ConsumptionBreakdown
                report={consumption.data}
                formatters={f}
                emptyLabel={t('reports.consumption.panelEmpty', {
                  vars: { days: REPORT_WINDOW_DAYS },
                })}
              />
            ) : null}
          </Panel>
        </Reveal>

        {/* Stock movement */}
        <div ref={movementView.ref}>
          <Reveal>
            <Panel
              title={`Stock movement (last ${movementWindow} days)`}
              action={
                <WindowToggle
                  value={movementWindow}
                  onChange={setMovementWindow}
                  formatters={f}
                  label="Stock movement window"
                />
              }
            >
              {!movementView.inView || movement.isLoading ? (
                <CentredSpinner />
              ) : movement.data ? (
                <MovementChart report={movement.data} formatters={f} />
              ) : (
                <p className="py-6 text-center text-sm text-destructive">
                  The stock movement report failed to load.
                </p>
              )}
            </Panel>
          </Reveal>
        </div>

        {/* Dead stock */}
        <Reveal>
          <Panel title={`Dead stock — no movement in ${deadStockDays} days`}>
            {deadStock.isLoading ? (
              <CentredSpinner />
            ) : deadStock.data && deadStock.data.lines.length > 0 ? (
              <DeadStockList lines={deadStock.data.lines} thresholdDays={deadStockDays} formatters={f} />
            ) : (
              // Reporting is opt-in (issue #92), so an empty panel is ambiguous on its own:
              // nothing is idle, or nothing is being watched. `consideredCount` says which.
              <p className="py-6 text-center text-sm text-muted-foreground">
                {deadStock.data && deadStock.data.consideredCount > 0
                  ? 'Nothing idle — all the stock you’re watching has moved recently.'
                  : 'No items are opted in to dead-stock reporting yet. Turn it on for a location, or for an individual item, to start watching for stock that stops moving.'}
              </p>
            )}
          </Panel>
        </Reveal>

        {/* Advanced analytics (Phase 74) — ABC, turnover, stock aging & valuation over time. */}
        <div ref={analyticsView.ref}>
          <Reveal as="section" className="flex flex-col gap-6" aria-labelledby="analytics-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="analytics-heading" className="text-base font-semibold tracking-tight">
                Advanced analytics
              </h2>
              <WindowToggle value={analyticsWindow} onChange={setAnalyticsWindow} formatters={f} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Panel title={`ABC analysis (annual consumption, ${ABC_WINDOW_DAYS}d)`}>
                {!analyticsInView || abc.isLoading ? (
                  <CentredSpinner />
                ) : abc.data ? (
                  <AbcBreakdown report={abc.data} formatters={f} emptyLabel="No consumption recorded yet." />
                ) : null}
              </Panel>

              <Panel title={`Inventory turnover (last ${analyticsWindow} days)`}>
                {!analyticsInView || turnover.isLoading ? (
                  <CentredSpinner />
                ) : turnover.data ? (
                  <TurnoverTable report={turnover.data} formatters={f} />
                ) : null}
              </Panel>

              <Panel title="Stock aging">
                {!analyticsInView || aging.isLoading ? (
                  <CentredSpinner />
                ) : aging.data ? (
                  <StockAgingChart report={aging.data} formatters={f} />
                ) : null}
              </Panel>

              <Panel title={`Valuation over time (last ${analyticsWindow} days)`}>
                {!analyticsInView || trend.isLoading ? (
                  <CentredSpinner />
                ) : trend.data ? (
                  <ValuationSparkline report={trend.data} formatters={f} />
                ) : null}
              </Panel>
            </div>
          </Reveal>
        </div>

        {/* Data hygiene (Phase 77) — a "tidy up" checklist of records needing attention. */}
        <div ref={hygieneView.ref}>
          <Reveal as="section" className="flex flex-col gap-3" aria-labelledby="hygiene-heading">
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
              {/* The gate is part of the test, not just of the query: an idle report has no
                  data and is not loading, which would otherwise read as "failed to load". */}
              {!hygieneView.inView || hygiene.isLoading ? (
                <CentredSpinner />
              ) : hygiene.data ? (
                <HygieneChecklist report={hygiene.data} formatters={f} />
              ) : (
                <p className="py-6 text-center text-sm text-destructive">
                  The data hygiene report failed to load.
                </p>
              )}
            </Panel>
          </Reveal>
        </div>

        {/* Spend analytics (Phase 79) — money OUT over time, by source/supplier/category.
            Distinct from the valuation trend above (inventory value). Dropped when the
            Purchase-orders module is off (Modular UI Phase 7). */}
        {spendOn ? (
          <div ref={spendView.ref}>
            <Reveal as="section" className="flex flex-col gap-3" aria-labelledby="spend-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="spend-heading" className="text-base font-semibold tracking-tight">
                  Spend analytics
                </h2>
                <WindowToggle
                  value={spendWindow}
                  onChange={setSpendWindow}
                  formatters={f}
                  label="Spend window"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Cash out from received purchase orders, project expenses and asset acquisitions. An item
                bought through a purchase order may also carry an acquisition price, so sources can overlap.
              </p>
              <Panel title={`Spend (last ${spendWindow} days)`}>
                {!spendView.inView || spend.isLoading ? (
                  <CentredSpinner />
                ) : spend.data ? (
                  <SpendBreakdown report={spend.data} formatters={f} baseCurrency={baseCurrency} />
                ) : (
                  <p className="py-6 text-center text-sm text-destructive">
                    The spend analytics report failed to load.
                  </p>
                )}
              </Panel>
            </Reveal>
          </div>
        ) : null}

        {/* Sales & disposals — proceeds vs a cost snapshot (→ margin), plus written-off value.
            Dropped when the Sales & disposals module is off. */}
        {salesOn ? (
          <div ref={salesView.ref}>
            <Reveal as="section" className="flex flex-col gap-3" aria-labelledby="sales-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="sales-heading" className="text-base font-semibold tracking-tight">
                  Sales &amp; disposals
                </h2>
                <WindowToggle
                  value={salesWindow}
                  onChange={setSalesWindow}
                  formatters={f}
                  label="Sales window"
                />
              </div>
              <p className="text-sm text-muted-foreground">{t('reports.sales.description')}</p>
              <Panel title={`Sales (last ${salesWindow} days)`}>
                {!salesView.inView || sales.isLoading ? (
                  <CentredSpinner />
                ) : sales.data ? (
                  <SalesBreakdown report={sales.data} formatters={f} />
                ) : (
                  <p className="py-6 text-center text-sm text-destructive">
                    The sales analytics report failed to load.
                  </p>
                )}
              </Panel>
            </Reveal>
          </div>
        ) : null}
      </main>

      {mayExport ? <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} /> : null}

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

      {/* The spend-analytics block's own once-only completion region (Phase 79); omitted with
          the section when the Purchase-orders module is off (Modular UI Phase 7). */}
      {spendOn ? (
        <>
          <LiveRegion visuallyHidden data-testid="spend-live-region">
            {!spend.isError && spendAnnouncement ? <p>{spendAnnouncement}</p> : null}
          </LiveRegion>
          <LiveRegion urgency="assertive" visuallyHidden data-testid="spend-error-live-region">
            {spend.isError && spendAnnouncement ? <p>{spendAnnouncement}</p> : null}
          </LiveRegion>
        </>
      ) : null}

      {/* The sales-analytics block's own once-only completion region; omitted with the section
          when the Sales & disposals module is off. */}
      {salesOn ? (
        <>
          <LiveRegion visuallyHidden data-testid="sales-live-region">
            {!sales.isError && salesAnnouncement ? <p>{salesAnnouncement}</p> : null}
          </LiveRegion>
          <LiveRegion urgency="assertive" visuallyHidden data-testid="sales-error-live-region">
            {sales.isError && salesAnnouncement ? <p>{salesAnnouncement}</p> : null}
          </LiveRegion>
        </>
      ) : null}
    </PageContainer>
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
              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
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
  value: React.ReactNode;
  sub?: string;
  loading?: boolean;
  tone?: 'warning';
  icon?: React.ReactNode;
  testId?: string;
}) {
  return (
    <Surface className="flex h-full flex-col gap-1 p-4">
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

/**
 * A titled report surface. `action` is an optional control rendered opposite the heading — the
 * Stock-movement panel uses it for its window toggle; panels without one keep the plain heading.
 */
function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Surface className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {action}
      </div>
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
