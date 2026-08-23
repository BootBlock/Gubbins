/**
 * The delivery-log viewer (webhooks plan `W7`; see §3.1).
 *
 * The log lives in **bridge memory**, not the database: the bridge is read-only over a snapshot
 * that is swapped wholesale on every hydration, so anything it wrote back would be discarded. That
 * is why this reads over the network, and why it only polls while the screen is open.
 *
 * ## Every failure gets its own explanation
 *
 * The temptation is to collapse "couldn't read the log" into one empty state. That would be the
 * single most misleading thing this screen could do — "no deliveries yet" and "webhooks are
 * switched off on your bridge" look identical and demand completely different actions. So each
 * failure reason renders its own sentence, and `blocked` rows in particular are explained rather
 * than shown raw: a refused private address is the **expected** setup for a LAN receiver and is a
 * configuration step, not an error.
 *
 * A bridge restart gets the same treatment. The log is in bridge memory, so a restart empties it —
 * and restarting to apply a setting is exactly what the "Blocked" explanation above asks a user to
 * do. A list that silently got shorter would read as "the change did nothing", so the restart is
 * stated instead.
 */
import { Banner, Button, LiveRegion, Surface } from '@/components/foundry';
import { RefreshIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import type { WebhookBridgeFailure, WebhookDelivery, WebhookDeliveryOutcome } from '../bridge-client';
import type { WebhookDeliveriesState } from '../useWebhookDeliveries';

const FAILURE_KEYS = {
  unauthorised: 'webhooks.log.failure.unauthorised',
  'not-enabled': 'webhooks.log.failure.notEnabled',
  'bridge-unreachable': 'webhooks.log.failure.unreachable',
  'rate-limited': 'webhooks.log.failure.rateLimited',
  'not-synced': 'webhooks.log.failure.notSynced',
  'bad-response': 'webhooks.log.failure.badResponse',
} as const satisfies Record<WebhookBridgeFailure, MessageKey>;

const OUTCOME_KEYS = {
  delivered: 'webhooks.log.outcome.delivered',
  failed: 'webhooks.log.outcome.failed',
  blocked: 'webhooks.log.outcome.blocked',
  skipped: 'webhooks.log.outcome.skipped',
} as const satisfies Record<WebhookDeliveryOutcome, MessageKey>;

/** Tone tokens per outcome — never a raw colour. */
const OUTCOME_TONES = {
  delivered: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  blocked: 'bg-warning/15 text-warning',
  skipped: 'bg-muted text-muted-foreground',
} as const satisfies Record<WebhookDeliveryOutcome, string>;

export interface WebhookDeliveryLogProps {
  readonly state: WebhookDeliveriesState;
  readonly onRefresh: () => void;
}

export function WebhookDeliveryLog({ state, onRefresh }: WebhookDeliveryLogProps) {
  const t = useT();

  return (
    <section aria-labelledby="webhooks-log-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="webhooks-log-heading" className="text-sm font-semibold text-foreground">
          {t('webhooks.log.heading')}
        </h2>
        {state.status === 'ready' || state.status === 'failed' ? (
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshIcon aria-hidden />
            {t('webhooks.log.refresh')}
          </Button>
        ) : null}
      </div>

      {/* Always-mounted region: a `role="status"` element inserted at the moment its message
          appears often goes unannounced, and this one arrives on a poll rather than in response
          to anything the user did — so a screen-reader user would otherwise get no signal at all
          that the list restarted. The Banner inside carries no role of its own; the region owns
          the announcement. */}
      <LiveRegion className="empty:hidden">
        {state.status === 'ready' && state.restarted ? (
          <Banner tone="info" role="none">
            {t('webhooks.log.restarted')}
          </Banner>
        ) : null}
      </LiveRegion>

      {state.status === 'unconfigured' ? (
        <Surface className="p-4">
          <p className="text-sm text-muted-foreground">{t('webhooks.log.unconfigured')}</p>
        </Surface>
      ) : state.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">{t('webhooks.log.loading')}</p>
      ) : state.status === 'failed' ? (
        <Banner tone={state.failure === 'not-enabled' ? 'warning' : 'danger'} role="alert">
          {t(FAILURE_KEYS[state.failure])}
        </Banner>
      ) : state.deliveries.length === 0 ? (
        <Surface className="p-4">
          <p className="text-sm text-muted-foreground">{t('webhooks.log.empty')}</p>
        </Surface>
      ) : (
        <ul className="flex flex-col gap-2">
          {/* Keyed by the poller's own row id, not `seq`: sequence numbers are unique only within
              one log instance, and a restart starts them again from zero. */}
          {state.deliveries.map(({ key, delivery }) => (
            <li key={key}>
              <DeliveryRow delivery={delivery} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeliveryRow({ delivery }: { readonly delivery: WebhookDelivery }) {
  const t = useT();
  const { dateTime } = useFormatters();

  return (
    <Surface className="flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_TONES[delivery.outcome]}`}>
          {t(OUTCOME_KEYS[delivery.outcome])}
        </span>
        <span className="text-sm font-medium text-foreground">{delivery.targetName}</span>
        {/* Empty for a refusal the bridge decided before any event was considered — it names no
            event type rather than asserting one that never happened, so the span is dropped. */}
        {delivery.eventType !== '' ? (
          <span className="text-xs text-muted-foreground">{delivery.eventType}</span>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground">{dateTime(delivery.at)}</span>
      </div>

      <p className="text-xs text-muted-foreground">
        {delivery.method} {delivery.url}
        {delivery.status !== null ? ` · ${String(delivery.status)}` : ''}
        {delivery.attempts > 1
          ? ` · ${t('webhooks.log.attempts', { vars: { count: delivery.attempts } })}`
          : ''}
      </p>

      {delivery.detail !== null ? <p className="text-xs text-muted-foreground">{delivery.detail}</p> : null}

      {delivery.outcome === 'blocked' ? (
        // The two reasons a delivery is refused before any request leaves the bridge, both of which
        // are configuration rather than breakage.
        <p className="text-xs text-warning">{t('webhooks.log.blockedHint')}</p>
      ) : null}
    </Surface>
  );
}
