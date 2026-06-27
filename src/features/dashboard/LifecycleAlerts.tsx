/**
 * Dashboard "lifecycle alerts" board (spec §3 customisable widgets, Phase 9): the
 * Soon-to-Expire (§4 perishables), Overdue borrowing (§4 Due Dates), Maintenance
 * Due (§4.3) and In-Transit (§4 procurement) trackers. Each is a compact, polished
 * card surfacing a count plus the most pressing rows, with a quick-link into the
 * relevant workspace. Reads are paginated Tier-1 queries; the cards stay quiet
 * (muted, not alarming) when there is nothing to action.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Surface } from '@/components/foundry';
import { ExpiryIcon, DueDateIcon, MaintenanceIcon, TruckIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useExpiringItems, useInTransitLines, useDueMaintenance } from '@/features/lifecycle';
import { useOpenCheckouts } from '@/features/contacts/contacts';
import { formatDate } from '@/features/inventory/components/inventory-ui';

export function LifecycleAlerts() {
  const expiring = useExpiringItems();
  const dueMaintenance = useDueMaintenance();
  const openCheckouts = useOpenCheckouts();
  const inTransit = useInTransitLines();

  const expiringRows = expiring.data?.rows ?? [];
  const maintenanceRows = dueMaintenance.data?.rows ?? [];
  const overdue = (openCheckouts.data?.rows ?? []).filter((c) => c.isOverdue);
  const inTransitRows = inTransit.data?.rows ?? [];

  return (
    <section className="mt-6">
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Lifecycle alerts</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AlertCard
          icon={<ExpiryIcon />}
          title="Soon to expire"
          count={expiringRows.length}
          tone={expiringRows.length > 0 ? 'warning' : 'quiet'}
          to="/inventory"
          testId="widget-expiring"
        >
          {expiringRows.slice(0, 3).map((item) => (
            <WidgetRow key={item.id} label={item.name} meta={item.expiryDate ? formatDate(item.expiryDate) : ''} />
          ))}
        </AlertCard>

        <AlertCard
          icon={<DueDateIcon />}
          title="Overdue items"
          count={overdue.length}
          tone={overdue.length > 0 ? 'danger' : 'quiet'}
          to="/contacts"
          testId="widget-overdue"
        >
          {overdue.slice(0, 3).map((c) => (
            <WidgetRow key={c.id} label={c.itemName} meta={`with ${c.contactName}`} />
          ))}
        </AlertCard>

        <AlertCard
          icon={<MaintenanceIcon />}
          title="Maintenance due"
          count={maintenanceRows.length}
          tone={maintenanceRows.length > 0 ? 'warning' : 'quiet'}
          to="/inventory"
          testId="widget-maintenance"
        >
          {maintenanceRows.slice(0, 3).map((m) => (
            <WidgetRow key={m.id} label={m.itemName} meta={m.name} />
          ))}
        </AlertCard>

        <AlertCard
          icon={<TruckIcon />}
          title="In transit"
          count={inTransitRows.length}
          tone={inTransitRows.length > 0 ? 'info' : 'quiet'}
          to="/inventory"
          testId="widget-in-transit"
        >
          {inTransitRows.slice(0, 3).map((line) => (
            <WidgetRow key={line.lineId} label={line.label} meta={`×${line.requiredQty}`} />
          ))}
        </AlertCard>
      </div>
    </section>
  );
}

type Tone = 'quiet' | 'info' | 'warning' | 'danger';

const TONE_COUNT: Record<Tone, string> = {
  quiet: 'text-muted-foreground',
  info: 'text-primary',
  warning: 'text-warning',
  danger: 'text-destructive',
};

function AlertCard({
  icon,
  title,
  count,
  tone,
  to,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  tone: Tone;
  to: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="block">
      <Surface
        className="h-full p-4 transition-transform duration-200 hover:-translate-y-0.5"
        data-testid={testId}
      >
        <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
          {icon}
          <h3 className="text-xs font-semibold text-foreground">{title}</h3>
          <span className={cn('ml-auto text-lg font-semibold tabular-nums', TONE_COUNT[tone])}>{count}</span>
        </div>
        <div className="mt-2 space-y-1">
          {count === 0 ? <p className="text-xs text-muted-foreground">All clear.</p> : children}
        </div>
      </Surface>
    </Link>
  );
}

function WidgetRow({ label, meta }: { label: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate font-medium">{label}</span>
      <span className="shrink-0 text-muted-foreground">{meta}</span>
    </div>
  );
}
