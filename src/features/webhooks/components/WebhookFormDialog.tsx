/**
 * Create / edit a webhook subscription (webhooks plan `W7`).
 *
 * Every field is validated through the pure `planWebhookSubscription` — the same choke-point the
 * repository uses — rather than by hand here, so the editor and storage can never disagree about
 * what a valid subscription is.
 *
 * ## The signing choice is the interesting part (§6.1)
 *
 * The dialog **steers to `secret_ref`**: the row stores only a *name*, and the value lives in the
 * bridge's own config, so it never enters the database, the sync artefact, or any backup. The
 * in-row `secret` is offered as the zero-setup fallback, with the trade-off stated plainly instead
 * of buried — it travels with synced data in plaintext.
 *
 * Where the user takes that fallback the value is **generated, never typed**, shown exactly once
 * with a copy button, and thereafter only regenerable. An existing secret is never redisplayed:
 * there is nothing to remember, so there is no reason to put it back on screen.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  FormField,
  Input,
  Modal,
  SelectField,
  Surface,
} from '@/components/foundry';
import { CopyIcon, RefreshIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { WEBHOOK_METHODS, type WebhookMethod } from '@/db/repositories/constants';
import type { WebhookSubscription } from '@/db/repositories';
import { DEFAULT_SUBSCRIBED_EVENT_TYPES } from '@/features/events/event-catalogue';
import { planWebhookSubscription, type WebhookPlanError } from '../subscription';
import { generateWebhookSecret } from '../secret';
import {
  emptyWebhookFilterForm,
  formToWebhookFilter,
  webhookFilterToForm,
  type WebhookFilterForm,
} from '../filter-form';
import { EventTypePicker } from './EventTypePicker';
import { WebhookFilterBuilder } from './WebhookFilterBuilder';
import { WebhookTemplateEditor } from './WebhookTemplateEditor';

/** How this subscription is signed. Exactly one of `secret` / `secretRef` may be set. */
type SigningMode = 'ref' | 'inline' | 'none';

const PLAN_ERROR_KEYS = {
  EMPTY_NAME: 'webhooks.form.error.name',
  INVALID_URL: 'webhooks.form.error.url',
  NO_EVENT_TYPES: 'webhooks.form.error.events',
  SECRET_CONFLICT: 'webhooks.form.error.secretConflict',
  INVALID_HEADERS: 'webhooks.form.error.headers',
} as const satisfies Record<WebhookPlanError, MessageKey>;

export interface WebhookFormDialogProps {
  /** The subscription being edited, or `null` to create one. */
  readonly subscription: WebhookSubscription | null;
  readonly onClose: () => void;
  readonly onSubmit: (values: WebhookFormSubmit) => void;
  readonly busy: boolean;
  readonly error: string | null;
}

/** What the dialog hands back — already normalised by `planWebhookSubscription`. */
export interface WebhookFormSubmit {
  readonly name: string;
  readonly url: string;
  readonly method: WebhookMethod;
  readonly enabled: boolean;
  readonly secret: string | null;
  readonly secretRef: string | null;
  readonly eventTypes: readonly string[];
  readonly filter: ReturnType<typeof formToWebhookFilter>;
  readonly template: string | null;
}

export function WebhookFormDialog({ subscription, onClose, onSubmit, busy, error }: WebhookFormDialogProps) {
  const t = useT();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(subscription?.name ?? '');
  const [url, setUrl] = useState(subscription?.url ?? '');
  const [method, setMethod] = useState<WebhookMethod>(subscription?.method ?? 'POST');
  const [enabled, setEnabled] = useState(subscription?.enabled ?? true);
  const [eventTypes, setEventTypes] = useState<readonly string[]>(
    subscription?.eventTypes ?? DEFAULT_SUBSCRIBED_EVENT_TYPES,
  );
  const [template, setTemplate] = useState<string | null>(subscription?.template ?? null);

  const [signingMode, setSigningMode] = useState<SigningMode>(
    subscription === null
      ? 'ref'
      : subscription.secretRef !== null
        ? 'ref'
        : subscription.secret !== null
          ? 'inline'
          : 'none',
  );
  const [secretRef, setSecretRef] = useState(subscription?.secretRef ?? '');
  /**
   * A secret generated in *this* session — the only one ever shown, and shown once. `null` means
   * "keep whatever is already stored", which is re-submitted unchanged but deliberately never
   * rendered: there is nothing for the user to memorise, so putting it back on screen would widen
   * its exposure for no benefit.
   */
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hasStoredSecret = subscription?.secret !== null && subscription?.secret !== undefined;

  // A filter shape the builder cannot represent (a nested tree, a `not`, or an `item` leaf) is held
  // aside and shown read-only rather than being rewritten into something the user did not ask for.
  const initialForm = useMemo(() => webhookFilterToForm(subscription?.filter ?? null), [subscription]);
  const [filterForm, setFilterForm] = useState<WebhookFilterForm>(initialForm ?? emptyWebhookFilterForm());
  const [unrepresentable, setUnrepresentable] = useState(
    initialForm === null ? (subscription?.filter ?? null) : null,
  );

  const [validationKey, setValidationKey] = useState<MessageKey | null>(null);

  const submit = (): void => {
    const secret = signingMode === 'inline' ? (freshSecret ?? subscription?.secret ?? null) : null;

    // Asking for a stored secret and never generating one would otherwise save silently and
    // deliver **unsigned** — the gap between what the user chose and what they got is exactly the
    // kind of thing a signing control must never have. `planWebhookSubscription` cannot catch it:
    // "no secret" is a legitimate subscription, just not the one asked for here.
    if (signingMode === 'inline' && secret === null) {
      setValidationKey('webhooks.form.error.secretMissing');
      return;
    }

    const plan = planWebhookSubscription({
      name,
      url,
      method,
      enabled,
      secret,
      secretRef: signingMode === 'ref' ? secretRef : null,
      eventTypes,
      filter: unrepresentable ?? formToWebhookFilter(filterForm),
      template,
    });

    if (!plan.ok) {
      setValidationKey(PLAN_ERROR_KEYS[plan.reason]);
      return;
    }

    setValidationKey(null);
    onSubmit({
      name: plan.subscription.name,
      url: plan.subscription.url,
      method: plan.subscription.method,
      enabled: plan.subscription.enabled,
      secret: plan.subscription.secret,
      secretRef: plan.subscription.secretRef,
      eventTypes: plan.subscription.eventTypes,
      filter: plan.subscription.filter,
      template: plan.subscription.template,
    });
  };

  const regenerate = (): void => {
    setFreshSecret(generateWebhookSecret());
    setCopied(false);
  };

  const copySecret = (): void => {
    if (freshSecret === null) return;
    void navigator.clipboard.writeText(freshSecret).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={subscription === null ? t('webhooks.form.addTitle') : t('webhooks.form.editTitle')}
      description={t('webhooks.form.description')}
      initialFocusRef={nameRef}
      className="max-w-3xl"
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField label={t('webhooks.form.name')}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={t('webhooks.form.namePlaceholder')}
          />
        </FormField>

        <FormField label={t('webhooks.form.url')} hint={t('webhooks.form.urlHint')}>
          <Input
            value={url}
            inputMode="url"
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://example.com/hooks/gubbins"
          />
        </FormField>

        <SelectField
          label={t('webhooks.form.method')}
          value={method}
          onChange={(value) => setMethod(value as WebhookMethod)}
          options={WEBHOOK_METHODS.map((entry) => ({ value: entry, label: entry }))}
        />
        {method === 'GET' ? (
          // Stated where the choice is made, not in a footnote: a GET carries its payload in the
          // query string, and there is no body to sign.
          <p className="text-xs text-muted-foreground">{t('webhooks.form.getNoSignature')}</p>
        ) : null}

        <label className="flex items-center gap-3">
          <Checkbox checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
          <span className="text-sm text-foreground">{t('webhooks.form.enabled')}</span>
        </label>

        <SigningSection
          mode={signingMode}
          onModeChange={(next) => {
            setSigningMode(next);
            setFreshSecret(null);
            setCopied(false);
          }}
          secretRef={secretRef}
          onSecretRefChange={setSecretRef}
          freshSecret={freshSecret}
          hasStoredSecret={hasStoredSecret}
          copied={copied}
          onGenerate={regenerate}
          onCopy={copySecret}
          method={method}
        />

        <section className="flex flex-col gap-field-gap">
          <h3 className="text-sm font-semibold text-foreground">{t('webhooks.form.eventsTitle')}</h3>
          <EventTypePicker value={eventTypes} onChange={setEventTypes} />
        </section>

        <section className="flex flex-col gap-field-gap">
          <h3 className="text-sm font-semibold text-foreground">{t('webhooks.form.filterTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('webhooks.form.filterHint')}</p>
          <WebhookFilterBuilder
            form={filterForm}
            onChange={setFilterForm}
            unrepresentable={unrepresentable}
            onDiscardUnrepresentable={() => {
              setUnrepresentable(null);
              setFilterForm(emptyWebhookFilterForm());
            }}
          />
        </section>

        <section className="flex flex-col gap-field-gap">
          <h3 className="text-sm font-semibold text-foreground">{t('webhooks.form.templateTitle')}</h3>
          <WebhookTemplateEditor value={template} onChange={setTemplate} method={method} />
        </section>

        {validationKey !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {t(validationKey)}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('webhooks.form.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {subscription === null ? t('webhooks.form.create') : t('webhooks.form.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SigningSection({
  mode,
  onModeChange,
  secretRef,
  onSecretRefChange,
  freshSecret,
  hasStoredSecret,
  copied,
  onGenerate,
  onCopy,
  method,
}: {
  readonly mode: SigningMode;
  readonly onModeChange: (next: SigningMode) => void;
  readonly secretRef: string;
  readonly onSecretRefChange: (next: string) => void;
  readonly freshSecret: string | null;
  readonly hasStoredSecret: boolean;
  readonly copied: boolean;
  readonly onGenerate: () => void;
  readonly onCopy: () => void;
  readonly method: WebhookMethod;
}) {
  const t = useT();

  return (
    <section className="flex flex-col gap-field-gap">
      <h3 className="text-sm font-semibold text-foreground">{t('webhooks.form.signingTitle')}</h3>

      <SelectField
        label={t('webhooks.form.signing')}
        value={mode}
        onChange={(value) => onModeChange(value as SigningMode)}
        options={[
          { value: 'ref', label: t('webhooks.form.signing.ref'), meta: t('webhooks.form.signing.refMeta') },
          { value: 'inline', label: t('webhooks.form.signing.inline') },
          { value: 'none', label: t('webhooks.form.signing.none') },
        ]}
      />

      {mode === 'ref' ? (
        <>
          <FormField label={t('webhooks.form.secretRef')} hint={t('webhooks.form.secretRefHint')}>
            <Input
              value={secretRef}
              onChange={(event) => onSecretRefChange(event.currentTarget.value)}
              placeholder="my-receiver"
            />
          </FormField>
          <Banner tone="info">{t('webhooks.form.secretRefBlocked')}</Banner>
        </>
      ) : null}

      {mode === 'inline' ? (
        <Surface className="flex flex-col gap-3 p-4">
          <Banner tone="warning">{t('webhooks.form.secretTravels')}</Banner>

          {freshSecret !== null ? (
            <div className="flex flex-col gap-field-gap-compact">
              <p className="text-xs text-muted-foreground">{t('webhooks.form.secretOnce')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                  {freshSecret}
                </code>
                <Button variant="outline" onClick={onCopy} aria-label={t('webhooks.form.secretCopy')}>
                  <CopyIcon aria-hidden />
                </Button>
              </div>
              {copied ? <p className="text-xs text-success">{t('webhooks.form.secretCopied')}</p> : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {hasStoredSecret ? t('webhooks.form.secretStored') : t('webhooks.form.secretNone')}
            </p>
          )}

          <div>
            <Button variant="outline" onClick={onGenerate}>
              <RefreshIcon aria-hidden />
              {hasStoredSecret || freshSecret !== null
                ? t('webhooks.form.secretRegenerate')
                : t('webhooks.form.secretGenerate')}
            </Button>
          </div>
        </Surface>
      ) : null}

      {mode === 'none' ? (
        <p className="text-xs text-muted-foreground">{t('webhooks.form.signing.noneHint')}</p>
      ) : null}

      {mode !== 'none' && method === 'GET' ? (
        <p className="text-xs text-warning">{t('webhooks.form.getSigningWarning')}</p>
      ) : null}
    </section>
  );
}
