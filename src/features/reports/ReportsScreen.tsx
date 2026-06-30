import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, LiveRegion, Spinner, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  ExportIcon,
  LowStockIcon,
  PackageIcon,
  ReportIcon,
} from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { ExportWizard } from '@/features/export/ExportWizard';
import { useFormatters } from '@/lib/useFormatters';
import { ValueBreakdown } from './components/ValueBreakdown';
import { MovementChart } from './components/MovementChart';
import {
  DEAD_STOCK_SINCE_DAYS,
  REPORT_WINDOW_DAYS,
  useConsumptionRate,
  useDeadStock,
  useInventoryValue,
  useLowStockCount,
  useMovement,
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

  const value = useInventoryValue();
  const consumption = useConsumptionRate();
  const movement = useMovement();
  const lowStock = useLowStockCount();
  const deadStock = useDeadStock();

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

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <ReportIcon /> Reports &amp; valuation
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => setExportOpen(true)} data-testid="open-report-export">
            <ExportIcon />
            Export CSV
          </Button>
          <Link
            to="/inventory"
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
          >
            <PackageIcon />
            Inventory
          </Link>
        </div>
      </header>

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
      </main>

      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />

      {/* Pre-mounted announce-only regions; content mutates once reports resolve so the
          transition from "Loading…" to resolved values is announced to assistive tech
          (WCAG 4.1.3). Two regions so polite "ready" and assertive "error" are always
          mounted — switching role on a single region breaks screen-reader registration. */}
      <LiveRegion visuallyHidden data-testid="reports-live-region">
        {!isAnyError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden>
        {isAnyError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
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
