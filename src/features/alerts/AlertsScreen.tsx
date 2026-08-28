/**
 * AlertsScreen — the §3 proactive alert centre (Phase 68).
 *
 * A consolidated, sorted feed of five alert lanes:
 *  - Low stock (items at or below reorder point)
 *  - Perishable expiry (expiring within the "soon" window, or already expired)
 *  - Maintenance due (schedules past their service interval)
 *  - Warranty due (warranty expiring soon or already expired, Phase-66 fields)
 *  - Custom field date (a DATE field its definition opted in as a due date, W1a)
 *
 * Each alert carries a Snooze menu and a Dismiss action (device-local, no migration).
 * Snoozing hides the alert until the chosen date and then lets it come back on its own —
 * the answer to "I have already ordered more, ask me again next week"; dismissing hides it
 * until the user restores it. A "Show all" control restores everything currently hidden.
 * Deep links navigate the user to the relevant item in the inventory.
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
  Menu,
  MenuAction,
  PageContainer,
  PageHeader,
  Spinner,
  Surface,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  AlertIcon,
  CriticalIcon,
  WarningIcon,
  ExpiryIcon,
  FieldDueIcon,
  MaintenanceIcon,
  NotificationIcon,
  PackageIcon,
  CloseIcon,
  SnoozeIcon,
} from '@/components/icons';
import { assertExhaustive } from '@/lib/exhaustive';
import { requestHighlight } from '@/lib/highlight';
import { useT, type MessageKey } from '@/features/i18n';
import { addCalendarDays } from '@/lib/calendar-days';
import { nowMs } from '@/lib/clock';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { exportAllRows } from '@/features/export/export-every-page';
import { alertsExportFilename, buildAlertsExport } from './alerts-export';
import {
  alertTargetLink,
  groupByKind,
  ALERT_KIND_LABEL as KIND_LABEL,
  ALERT_SEVERITY_LABEL as SEVERITY_LABEL,
  type Alert,
  type AlertKind,
  type AlertSeverity,
} from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';
import { useAlerts } from './useAlerts';

// ---------------------------------------------------------------------------
// Kind metadata — icons and section order for each lane
// ---------------------------------------------------------------------------

// The lane and severity *labels* live in the pure `alerts` seam, so the export (issue #132)
// names a row exactly as this screen names its section — one definition, no drift.

const KIND_ORDER: AlertKind[] = ['maintenance-due', 'warranty-due', 'field-due', 'expiry', 'low-stock'];

function KindIcon({ kind }: { kind: AlertKind }) {
  switch (kind) {
    case 'low-stock':
      return <PackageIcon aria-hidden />;
    case 'expiry':
      return <ExpiryIcon aria-hidden />;
    case 'maintenance-due':
      return <MaintenanceIcon aria-hidden />;
    case 'warranty-due':
      return <NotificationIcon aria-hidden />;
    case 'field-due':
      return <FieldDueIcon aria-hidden />;
    default:
      // Exhaustiveness guard (#355): a new alert lane must extend this switch or this stops
      // compiling. A component has no return-type annotation to fall back on, so without it
      // a new lane's rows would silently render with no icon at all.
      assertExhaustive(kind);
      return <AlertIcon aria-hidden />;
  }
}

// ---------------------------------------------------------------------------
// Snooze durations
// ---------------------------------------------------------------------------

/**
 * The offered "remind me later" windows, in calendar days (issue #134). Three is deliberate:
 * long enough to cover "a delivery is on its way" (a day), "I've ordered against it" (a week)
 * and "this can wait" (a month) without turning a two-click action into a date picker.
 *
 * The durations are calendar days, not fixed 24-hour blocks, so a snooze set the evening before
 * a clock change still ends at the same time of day (issue #325).
 */
const SNOOZE_PRESETS: readonly { readonly days: number; readonly labelKey: MessageKey }[] = [
  { days: 1, labelKey: 'alerts.snooze.day' },
  { days: 7, labelKey: 'alerts.snooze.week' },
  { days: 30, labelKey: 'alerts.snooze.month' },
];

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

// Each badge tints a faint fill with the *same* hue used for its text, so the label
// stays legible on both themes. `warning-foreground` is the near-black label meant to
// sit on a *solid* warning fill — on this 10%-opacity tint it was near-invisible in
// dark mode; the `warning` token itself is the correct on-tint text colour (mirroring
// how `critical` uses `text-destructive`, not `text-destructive-foreground`).
const SEVERITY_TOKEN: Record<AlertSeverity, string> = {
  critical: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/15 text-warning',
  info: 'bg-muted text-muted-foreground',
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
  onSnooze,
  onDismiss,
}: {
  alert: Alert;
  onSnooze: (alert: Alert, days: number) => void;
  onDismiss: (alert: Alert) => void;
}) {
  const t = useT();
  return (
    <Surface className="flex flex-col gap-2 p-4" data-testid={`alert-card-${alert.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <span className="text-sm font-medium">{alert.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Snooze — hide this alert for a while and let it come back by itself. Named after
              the alert it belongs to so a screen reader landing on the button knows which of
              the feed's many identical controls it has reached. */}
          <Menu
            label={t('alerts.snooze.menuLabel', { vars: { title: alert.title } })}
            trigger={<SnoozeIcon className="size-4" />}
            triggerVariant="ghost"
            triggerSize="icon"
            triggerClassName="size-7"
            triggerProps={{ 'data-testid': `snooze-alert-${alert.id}` }}
          >
            {SNOOZE_PRESETS.map((preset) => (
              <MenuAction
                key={preset.days}
                onSelect={() => onSnooze(alert, preset.days)}
                data-testid={`snooze-alert-${alert.id}-${preset.days}`}
              >
                {t(preset.labelKey)}
              </MenuAction>
            ))}
          </Menu>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('alerts.dismiss.buttonLabel', { vars: { title: alert.title } })}
            onClick={() => onDismiss(alert)}
            data-testid={`dismiss-alert-${alert.id}`}
            className="size-7"
          >
            <CloseIcon className="size-4" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{alert.detail}</p>
      {/* Deep-link: the link itself carries the inventory search that loads the target item, and
          the click asks the global highlight service to scroll it into view and flash it — the
          user lands on a filtered list with their item unmistakably called out. */}
      <Link
        {...alertTargetLink(alert.target)}
        onClick={() => {
          const { itemId } = alert.target;
          if (itemId) requestHighlight(itemId);
        }}
        className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
        data-testid={`alert-link-${alert.id}`}
      >
        View in inventory
      </Link>
    </Surface>
  );
}

/**
 * "This lane is showing a prefix" — the caveat under a section whose feed stopped short.
 *
 * A lane that quietly stops at a page boundary reads as "that is everything" when it is not
 * (issue #606). Where the lane has its own `COUNT(*)` the notice quotes it, so the user is told
 * exactly how many rows sit behind the cards; the custom-field lane walks every page and has no
 * total to quote, so its ceiling gets the wording it already had. A truncated lane whose total
 * has not arrived — or whose count query failed — still gets a notice, just without the figure:
 * the caveat is the load-bearing half.
 */
function LaneTruncationNotice({
  kind,
  shown,
  total,
  truncated,
}: {
  kind: AlertKind;
  shown: number;
  total: number | undefined;
  truncated: boolean;
}) {
  const t = useT();
  if (!truncated) return null;
  const copy =
    kind === 'field-due'
      ? t('alerts.fieldDue.truncated')
      : total !== undefined
        ? t('alerts.lane.truncatedOf', { vars: { shown, total } })
        : t('alerts.lane.truncated', { vars: { shown } });
  return (
    <p className="mb-3 text-xs text-muted-foreground" data-testid={`alerts-truncated-${kind}`}>
      {copy}
    </p>
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
  const t = useT();
  // `withTotals` — this is the screen that states a figure per lane, so it pays for the four
  // `COUNT(*)` reads the always-mounted nav badge does not need (issue #606).
  const { alerts, allAlerts, isLoading, isError, truncatedKinds, laneTotals, readAllAlerts } = useAlerts({
    withTotals: true,
  });
  const { dismiss, snooze, clearAll } = useDismissedAlertsStore();

  // Count what is hidden *right now* rather than how many records the store holds: a record for
  // an alert that is no longer firing hides nothing, and "Show all (0 hidden)" would restore
  // nothing visible. Snoozed and dismissed alerts both count — "Show all" brings back both.
  const hiddenCount = allAlerts.length - alerts.length;
  const hasHidden = hiddenCount > 0;

  // Hiding a card is a silent change for a screen-reader user, so each action says what it did
  // (WCAG 4.1.3). Kept apart from the count announcement below, which fires once on load.
  const [actionAnnouncement, setActionAnnouncement] = useState('');

  const handleSnooze = (alert: Alert, days: number) => {
    snooze(alert.id, addCalendarDays(nowMs(), days));
    setActionAnnouncement(t('alerts.snoozed', { vars: { title: alert.title } }));
  };

  const handleDismiss = (alert: Alert) => {
    dismiss(alert.id);
    setActionAnnouncement(t('alerts.dismissed', { vars: { title: alert.title } }));
  };

  const handleShowAll = () => {
    clearAll();
    setActionAnnouncement('');
  };

  // Group undismissed alerts by kind for sectioned rendering.
  const groups = groupByKind(alerts);

  // Announce the alert count once loading completes (WCAG 4.1.3).
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef(false);
  // A lane showing a prefix makes the spoken figure a floor rather than a total, so the copy
  // hedges to match — a screen-reader user is told "at least N", never a page size dressed up
  // as the whole (issue #606). Taken as a boolean because the Set is a fresh identity each render.
  const anyTruncated = truncatedKinds.size > 0;
  useEffect(() => {
    if (isLoading || announcedRef.current) return;
    announcedRef.current = true;
    if (isError) {
      setAnnouncement(t('alerts.announce.error'));
    } else {
      const count = alerts.length;
      setAnnouncement(
        count === 0
          ? t('alerts.announce.none')
          : t(anyTruncated ? 'alerts.announce.atLeast' : 'alerts.announce.count', {
              vars: { count },
            }),
      );
    }
  }, [t, isLoading, isError, alerts.length, anyTruncated]);

  return (
    <PageContainer>
      {/* Header ---------------------------------------------------------- */}
      <PageHeader
        icon={<AlertIcon />}
        title="Alert centre"
        actions={
          <>
            {hasHidden ? (
              <Button variant="outline" size="sm" onClick={handleShowAll} data-testid="alerts-show-all">
                {t('alerts.showAll', { vars: { count: hiddenCount } })}
              </Button>
            ) : null}
            {/*
             * Exports the alerts as shown — snoozed and dismissed ones stay out, because an
             * alert the user has explicitly set aside reappearing in the file would defeat the
             * point of setting it aside. Like every sibling list export on this screen's
             * pattern, it re-reads its source rather than serialising the page in hand: four of
             * the five lanes are one bounded page, so the file used to stop at the cap under a
             * comment claiming the hook held the whole list (issue #606).
             */}
            <TabularExportMenu
              build={(format) =>
                exportAllRows(
                  readAllAlerts,
                  (rows) => buildAlertsExport(format, rows),
                  t('export.list.truncated'),
                )
              }
              filename={alertsExportFilename}
              triggerLabel={t('export.list.trigger')}
              menuLabel={t('export.alerts.menuLabel')}
              toastHeading={t('export.alerts.toast')}
              disabled={isLoading || alerts.length === 0}
              testIdPrefix="export-alerts"
            />
          </>
        }
      />

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
              {hasHidden ? t('alerts.empty.allHidden') : t('alerts.empty.allClear')}
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
                  {/* Named to the lane it belongs to rather than shown as a page-wide caveat:
                      a general "this list may be short" would cast doubt on every lane that is
                      complete. The four paged lanes can say how many rows are behind the ones
                      listed, since each has its own `COUNT(*)`; the custom-field lane walks
                      every page, so its only short read is the `readAllPages` ceiling and it has
                      no total to quote (issue #606). */}
                  <LaneTruncationNotice
                    kind={kind}
                    shown={kindAlerts.length}
                    total={laneTotals[kind]}
                    truncated={truncatedKinds.has(kind)}
                  />
                  <div className="flex flex-col gap-3">
                    {kindAlerts.map((alert) => (
                      <AlertCard
                        key={alert.id}
                        alert={alert}
                        onSnooze={handleSnooze}
                        onDismiss={handleDismiss}
                      />
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
      {/* Confirms a snooze or dismissal, which otherwise just removes a card in silence. */}
      <LiveRegion visuallyHidden data-testid="alerts-action-live-region">
        {actionAnnouncement ? <p>{actionAnnouncement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="alerts-error-live-region">
        {isError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </PageContainer>
  );
}
