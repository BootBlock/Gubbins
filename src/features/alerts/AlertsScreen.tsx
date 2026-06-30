/**
 * AlertsScreen — the §3 proactive alert centre (Phase 68).
 *
 * A consolidated, sorted feed of four alert lanes:
 *  - Low stock (items at or below reorder point)
 *  - Perishable expiry (expiring within the "soon" window, or already expired)
 *  - Maintenance due (schedules past their service interval)
 *  - Warranty due (warranty expiring soon or already expired, Phase-66 fields)
 *
 * Each alert carries a Dismiss action (device-local, no migration). Dismissed
 * alerts are hidden; a "Show all" control restores them. Deep links navigate the
 * user to the relevant item in the inventory.
 *
 * Accessibility: §3 WCAG 4.1.3 — an always-mounted `<LiveRegion>` announces the
 * undismissed count once data loads. The screen carries `id={MAIN_CONTENT_ID}` so
 * the skip-to-content link (Phase 40) works here too.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  LiveRegion,
  Spinner,
  Surface,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  AlertIcon,
  CriticalIcon,
  WarningIcon,
  ExpiryIcon,
  MaintenanceIcon,
  NotificationIcon,
  PackageIcon,
  CloseIcon,
} from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { groupByKind, type Alert, type AlertKind, type AlertSeverity } from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';
import { useAlerts } from './useAlerts';

// ---------------------------------------------------------------------------
// Kind metadata — labels & icons for each lane
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<AlertKind, string> = {
  'low-stock': 'Low stock',
  'expiry': 'Expiring stock',
  'maintenance-due': 'Maintenance due',
  'warranty-due': 'Warranty',
};

const KIND_ORDER: AlertKind[] = [
  'maintenance-due',
  'warranty-due',
  'expiry',
  'low-stock',
];

function KindIcon({ kind }: { kind: AlertKind }) {
  switch (kind) {
    case 'low-stock': return <PackageIcon aria-hidden />;
    case 'expiry': return <ExpiryIcon aria-hidden />;
    case 'maintenance-due': return <MaintenanceIcon aria-hidden />;
    case 'warranty-due': return <NotificationIcon aria-hidden />;
  }
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

const SEVERITY_TOKEN: Record<AlertSeverity, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning-foreground',
  info: 'bg-muted text-muted-foreground',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_TOKEN[severity]}`}
    >
      {severity === 'critical' ? (
        <CriticalIcon className="size-3" aria-hidden />
      ) : (
        <WarningIcon className="size-3" aria-hidden />
      )}
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single alert card
// ---------------------------------------------------------------------------

function AlertCard({
  alert,
  onDismiss,
}: {
  alert: Alert;
  onDismiss: (id: string) => void;
}) {
  return (
    <Surface
      className="flex flex-col gap-2 p-4"
      data-testid={`alert-card-${alert.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <span className="text-sm font-medium">{alert.title}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Dismiss alert: ${alert.title}`}
          onClick={() => onDismiss(alert.id)}
          data-testid={`dismiss-alert-${alert.id}`}
          className="size-7 shrink-0"
        >
          <CloseIcon className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{alert.detail}</p>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Link
        to={alert.target.route as any}
        className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
        data-testid={`alert-link-${alert.id}`}
      >
        View in inventory
      </Link>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

/**
 * The §3 alert centre screen — a single sorted alert feed composed from the four
 * existing alert sources (low stock, expiry, maintenance, warranty).
 */
export function AlertsScreen() {
  const { alerts, allAlerts, isLoading, isError } = useAlerts();
  const { dismiss, clearAll } = useDismissedAlertsStore();
  const dismissedIds = useDismissedAlertsStore((s) => s.dismissedIds);

  const hasDismissed = dismissedIds.size > 0;
  const hiddenCount = allAlerts.length - alerts.length;

  // Group undismissed alerts by kind for sectioned rendering.
  const groups = groupByKind(alerts);

  // Announce the alert count once loading completes (WCAG 4.1.3).
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef(false);
  useEffect(() => {
    if (isLoading || announcedRef.current) return;
    announcedRef.current = true;
    if (isError) {
      setAnnouncement('Alerts failed to load.');
    } else {
      const count = alerts.length;
      setAnnouncement(
        count === 0
          ? 'No active alerts — all looks good.'
          : `${count} alert${count === 1 ? '' : 's'} require your attention.`,
      );
    }
  }, [isLoading, isError, alerts.length]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6">
      {/* Header ---------------------------------------------------------- */}
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <AlertIcon />
          Alert centre
        </h1>
        {hasDismissed && (
          <Button
            variant="outline"
            size="sm"
            onClick={clearAll}
            className="ml-auto"
            data-testid="alerts-show-all"
          >
            Show all ({hiddenCount} hidden)
          </Button>
        )}
      </header>

      {/* Main content ----------------------------------------------------- */}
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-col gap-6 outline-none"
        data-testid="alerts-main"
      >
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="p-6 text-center text-sm text-destructive">
            Failed to load alerts. Please refresh the page.
          </Surface>
        )}

        {!isLoading && !isError && alerts.length === 0 && (
          <Surface className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertIcon className="size-10 text-muted-foreground" />
            <p className="font-medium">No active alerts</p>
            <p className="text-sm text-muted-foreground">
              {hasDismissed
                ? 'All alerts have been dismissed. Click "Show all" above to restore them.'
                : 'All stock levels, expiry dates, maintenance schedules and warranties look good.'}
            </p>
          </Surface>
        )}

        {!isLoading && !isError && alerts.length > 0 && (
          <div className="flex flex-col gap-6">
            {KIND_ORDER.map((kind) => {
              const kindAlerts = groups.get(kind);
              if (!kindAlerts || kindAlerts.length === 0) return null;
              return (
                <section key={kind} aria-labelledby={`alerts-section-${kind}`}>
                  <h2
                    id={`alerts-section-${kind}`}
                    className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4"
                  >
                    <KindIcon kind={kind} />
                    {KIND_LABEL[kind]}
                    <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {kindAlerts.length}
                    </span>
                  </h2>
                  <div className="flex flex-col gap-3">
                    {kindAlerts.map((alert) => (
                      <AlertCard key={alert.id} alert={alert} onDismiss={dismiss} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {/* Always-mounted live region (WCAG 4.1.3) — announces alert count. */}
      <LiveRegion visuallyHidden data-testid="alerts-live-region">
        {!isError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="alerts-error-live-region">
        {isError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </div>
  );
}
