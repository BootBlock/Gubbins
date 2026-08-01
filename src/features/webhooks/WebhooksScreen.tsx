/**
 * The Webhooks screen (webhooks plan `W7`; see §5.4).
 *
 * Gubbins configures webhooks; the **bridge delivers them** (§1). More than half the value of this
 * screen is saying so plainly, up front, before anyone builds a subscription that then appears not
 * to work. Four things are stated before the list, not discovered afterwards as failures:
 *
 *   1. **Webhooks need the bridge.** Said first, with a link to the setup guide — and creating one
 *      anyway is still allowed, because it starts delivering the moment the bridge is up. Blocking
 *      the form would be worse: it would make an ordering problem look like a missing feature.
 *   2. **Changes reach the bridge on the next sync.** The bridge reads subscriptions out of the
 *      database it hydrates, so a new subscription is live after the next sync, not instantly.
 *   3. **A LAN receiver needs an opt-in.** The bridge refuses private and loopback destinations
 *      unless its operator turns that on — and a LAN receiver (Home Assistant, Node-RED) is the
 *      *expected* setup, so this is explained as configuration and never as an error.
 *   4. **What can and cannot fire.** Webhooks cover changes to **items**. Other entities and
 *      permanent deletion cannot raise one at all — a boundary of the underlying ledger, stated
 *      rather than left to be discovered by a subscription that silently never fires (§3.3).
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Banner,
  Button,
  LiveRegion,
  MAIN_CONTENT_ID,
  Modal,
  PageContainer,
  PageHeader,
  Surface,
} from '@/components/foundry';
import { AddIcon, DeleteIcon, EditIcon, WebhookIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { BridgeReloadNotice } from '@/features/sync/BridgeReloadNotice';
import type { WebhookSubscription } from '@/db/repositories';
import { useWebhooks } from './queries';
import { useCreateWebhook, useDeleteWebhook, useUpdateWebhook } from './mutations';
import { useWebhookDeliveries } from './useWebhookDeliveries';
import { sendWebhookTestEvent, type BridgeConnection, type WebhookTestOutcome } from './bridge-client';
import { WEBHOOK_ALL_EVENTS } from './subscription';
import { WebhookDeliveryLog } from './components/WebhookDeliveryLog';
import { WebhookFormDialog, type WebhookFormSubmit } from './components/WebhookFormDialog';

/**
 * The real `fetch`, bound once at module scope. Kept out of the component deliberately — a fresh
 * arrow per render would change the connection's identity every time and re-arm the delivery poll.
 */
const browserFetch: BridgeConnection['fetchImpl'] = (url, init) => fetch(url, init);

const TEST_OUTCOME_KEYS = {
  delivered: 'webhooks.test.delivered',
  failed: 'webhooks.test.failed',
  blocked: 'webhooks.test.blocked',
  skipped: 'webhooks.test.skipped',
  unmatched: 'webhooks.test.unmatched',
} as const satisfies Record<WebhookTestOutcome, MessageKey>;

export function WebhooksScreen() {
  const t = useT();
  const webhooksQuery = useWebhooks();
  const createWebhook = useCreateWebhook();
  const updateWebhook = useUpdateWebhook();
  const deleteWebhook = useDeleteWebhook();

  const bridgeUrl = usePreferencesStore((s) => s.bridgeUrl);
  const bridgeToken = usePreferencesStore((s) => s.bridgeToken);
  const bridgeConfigured = bridgeUrl.trim() !== '' && bridgeToken.trim() !== '';
  // Memoised, and over a *module-level* `fetchImpl`: the delivery poller keys its effect on the
  // connection's fields, so rebuilding this object — or handing it a fresh arrow each render —
  // would re-arm the poll on every render and spin.
  const connection = useMemo<BridgeConnection | null>(
    () => (bridgeConfigured ? { baseUrl: bridgeUrl, token: bridgeToken, fetchImpl: browserFetch } : null),
    [bridgeConfigured, bridgeUrl, bridgeToken],
  );

  const { state: deliveriesState, refresh } = useWebhookDeliveries(connection);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookSubscription | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookSubscription | null>(null);

  const webhooks = webhooksQuery.data?.rows ?? [];

  const closeForm = (): void => {
    setAddOpen(false);
    setEditing(null);
    setFormError(null);
  };

  const submitForm = (values: WebhookFormSubmit): void => {
    setFormError(null);
    const onError = (error: unknown): void =>
      setFormError(error instanceof Error ? error.message : t('webhooks.form.error.generic'));

    if (editing !== null) {
      updateWebhook.mutate(
        { id: editing.id, input: values },
        {
          onSuccess: () => {
            setAnnouncement(t('webhooks.announce.saved', { vars: { name: values.name } }));
            closeForm();
          },
          onError,
        },
      );
      return;
    }

    createWebhook.mutate(values, {
      onSuccess: () => {
        setAnnouncement(t('webhooks.announce.created', { vars: { name: values.name } }));
        closeForm();
      },
      onError,
    });
  };

  // Deleting a subscription cannot be undone and takes its filter, template and signing choice
  // with it, so it is confirmed rather than fired from a single icon click.
  const remove = (subscription: WebhookSubscription): void => {
    deleteWebhook.mutate(subscription.id, {
      onSuccess: () => {
        setAnnouncement(t('webhooks.announce.deleted', { vars: { name: subscription.name } }));
        setDeleting(null);
      },
    });
  };

  const sendTest = (subscription: WebhookSubscription): void => {
    if (connection === null) return;
    setTestingId(subscription.id);
    void sendWebhookTestEvent(connection, subscription.id)
      .then((result) => {
        setAnnouncement(
          result.ok
            ? t(TEST_OUTCOME_KEYS[result.outcome], { vars: { name: subscription.name } })
            : t('webhooks.test.unavailable', { vars: { name: subscription.name } }),
        );
        // The bridge writes a real log row for a test, so pull it straight in rather than
        // waiting out the poll interval.
        refresh();
      })
      .finally(() => setTestingId(null));
  };

  return (
    <PageContainer>
      <PageHeader
        icon={<WebhookIcon />}
        title={t('webhooks.title')}
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <AddIcon aria-hidden />
            {t('webhooks.add')}
          </Button>
        }
      />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/* (1) The bridge requirement, stated before anything else on the screen. */}
        <Banner
          tone={bridgeConfigured ? 'info' : 'warning'}
          heading={t('webhooks.bridge.heading')}
          action={
            <Link to="/sync" className="text-sm font-medium underline">
              {t('webhooks.bridge.setUp')}
            </Link>
          }
        >
          {bridgeConfigured ? t('webhooks.bridge.configured') : t('webhooks.bridge.required')}
        </Banner>

        {/* Issue #385: the delivery log and test-fire are both app→bridge calls, so a bridge
            address this session was not started with reads here as an unreachable bridge until
            the app reloads. Renders nothing once the address is reachable. Delivery itself is
            unaffected either way — the bridge sends those, not the browser. */}
        <BridgeReloadNotice />

        <Surface className="flex flex-col gap-2 p-4">
          {/* (2) Hydration latency, and (3) the LAN opt-in — both configuration, not errors. */}
          <p className="text-sm text-muted-foreground">{t('webhooks.notes.latency')}</p>
          <p className="text-sm text-muted-foreground">{t('webhooks.notes.privateNetwork')}</p>
          {/* (4) What can and cannot fire — the ledger's boundary, said out loud. */}
          <p className="text-sm text-muted-foreground">{t('webhooks.notes.coverage')}</p>
        </Surface>

        <section aria-labelledby="webhooks-list-heading" className="flex flex-col gap-3">
          <h2 id="webhooks-list-heading" className="text-sm font-semibold text-foreground">
            {t('webhooks.list.heading')}
          </h2>

          {webhooksQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('webhooks.list.loading')}</p>
          ) : webhooksQuery.isError ? (
            // Never fall through to the empty state on failure — "no webhooks yet" would be a lie
            // that hides a real error behind copy reading like success.
            <Surface className="flex flex-col items-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('webhooks.list.error')}
              </p>
              <Button variant="outline" onClick={() => void webhooksQuery.refetch()}>
                {t('webhooks.list.retry')}
              </Button>
            </Surface>
          ) : webhooks.length === 0 ? (
            <Surface className="flex flex-col items-center gap-2 p-8 text-center">
              <WebhookIcon aria-hidden className="size-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">{t('webhooks.list.empty')}</p>
            </Surface>
          ) : (
            <ul className="flex flex-col gap-2">
              {webhooks.map((subscription) => (
                <li key={subscription.id}>
                  <WebhookRow
                    subscription={subscription}
                    canTest={connection !== null}
                    testing={testingId === subscription.id}
                    onEdit={() => setEditing(subscription)}
                    onDelete={() => setDeleting(subscription)}
                    onTest={() => sendTest(subscription)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <WebhookDeliveryLog state={deliveriesState} onRefresh={refresh} />
      </main>

      <LiveRegion visuallyHidden>{announcement}</LiveRegion>

      {addOpen ? (
        <WebhookFormDialog
          subscription={null}
          onClose={closeForm}
          onSubmit={submitForm}
          busy={createWebhook.isPending}
          error={formError}
        />
      ) : null}
      {editing !== null ? (
        <WebhookFormDialog
          subscription={editing}
          onClose={closeForm}
          onSubmit={submitForm}
          busy={updateWebhook.isPending}
          error={formError}
        />
      ) : null}
      {deleting !== null ? (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('webhooks.delete.title')}
          description={t('webhooks.delete.body', { vars: { name: deleting.name } })}
          busy={deleteWebhook.isPending}
        >
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteWebhook.isPending}>
              {t('webhooks.delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => remove(deleting)} disabled={deleteWebhook.isPending}>
              {t('webhooks.delete.confirm')}
            </Button>
          </div>
        </Modal>
      ) : null}
    </PageContainer>
  );
}

function WebhookRow({
  subscription,
  canTest,
  testing,
  onEdit,
  onDelete,
  onTest,
}: {
  readonly subscription: WebhookSubscription;
  readonly canTest: boolean;
  readonly testing: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onTest: () => void;
}) {
  const t = useT();
  const allEvents = subscription.eventTypes.includes(WEBHOOK_ALL_EVENTS);

  return (
    <Surface className="flex flex-wrap items-center gap-3 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{subscription.name}</span>
          {!subscription.enabled ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('webhooks.row.disabled')}
            </span>
          ) : null}
          {subscription.secretRef !== null ? (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
              {t('webhooks.row.signedByRef')}
            </span>
          ) : subscription.secret !== null ? (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              {t('webhooks.row.signedInline')}
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('webhooks.row.unsigned')}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {subscription.method} {subscription.url}
        </p>
        <p className="text-xs text-muted-foreground">
          {allEvents
            ? t('webhooks.row.allEvents')
            : t('webhooks.row.eventCount', { vars: { count: subscription.eventTypes.length } })}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onTest} disabled={!canTest || testing}>
          {testing ? t('webhooks.row.testing') : t('webhooks.row.test')}
        </Button>
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t('webhooks.row.edit')}>
          <EditIcon aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" onClick={onDelete} aria-label={t('webhooks.row.delete')}>
          <DeleteIcon aria-hidden />
        </Button>
      </div>
    </Surface>
  );
}
