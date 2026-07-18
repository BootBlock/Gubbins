/**
 * The declarative filter builder (webhooks plan `W7`; see §5.2).
 *
 * Emits the `WebhookFilter` discriminated union that `filter.ts` already defines — a **data
 * structure**, never a user-typed expression string. Nothing here is parsed or interpreted at
 * delivery time; the worst a filter can do is match, or not match.
 *
 * The conversion in both directions lives in the pure `filter-form.ts`, including the decision to
 * show a filter **read-only** when the builder cannot represent it (a nested tree, a `not`, or an
 * `item` leaf, all of which can arrive over sync from a peer on another build). Rewriting a filter
 * this editor only partly understood would change what a subscription delivers without anyone
 * asking, so it declines to try.
 */
import { useId } from 'react';
import { Button, Checkbox, Input, Select, SelectField, Surface } from '@/components/foundry';
import { CloseIcon, AddIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { useCategories } from '@/features/inventory/categories';
import { useLocations } from '@/features/inventory/queries';
import { useTagDictionary } from '@/features/inventory/tags';
import { WEBHOOK_FILTER_OPS, type WebhookFilter, type WebhookFilterOp } from '../filter';
import {
  isWebhookFormConditionComplete,
  newWebhookFormCondition,
  WEBHOOK_FORM_CONDITION_KINDS,
  type WebhookFilterForm,
  type WebhookFormCondition,
  type WebhookFormConditionKind,
} from '../filter-form';

export interface WebhookFilterBuilderProps {
  readonly form: WebhookFilterForm;
  readonly onChange: (next: WebhookFilterForm) => void;
  /**
   * The stored filter when it is not representable in the builder. Rendered read-only instead of
   * the editor, with an explicit opt-in to discard it.
   */
  readonly unrepresentable: WebhookFilter | null;
  readonly onDiscardUnrepresentable: () => void;
}

const CONDITION_LABEL_KEYS = {
  location: 'webhooks.filter.kind.location',
  category: 'webhooks.filter.kind.category',
  tag: 'webhooks.filter.kind.tag',
  quantity: 'webhooks.filter.kind.quantity',
} as const satisfies Record<WebhookFormConditionKind, MessageKey>;

const OP_LABEL_KEYS = {
  lt: 'webhooks.filter.op.lt',
  lte: 'webhooks.filter.op.lte',
  gt: 'webhooks.filter.op.gt',
  gte: 'webhooks.filter.op.gte',
  eq: 'webhooks.filter.op.eq',
  neq: 'webhooks.filter.op.neq',
} as const satisfies Record<WebhookFilterOp, MessageKey>;

export function WebhookFilterBuilder({
  form,
  onChange,
  unrepresentable,
  onDiscardUnrepresentable,
}: WebhookFilterBuilderProps) {
  const t = useT();

  if (unrepresentable !== null) {
    return (
      <Surface className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">{t('webhooks.filter.advanced')}</p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">
          {JSON.stringify(unrepresentable, null, 2)}
        </pre>
        <div>
          <Button variant="outline" onClick={onDiscardUnrepresentable}>
            {t('webhooks.filter.replace')}
          </Button>
        </div>
      </Surface>
    );
  }

  const setCondition = (id: string, next: WebhookFormCondition): void => {
    onChange({
      ...form,
      conditions: form.conditions.map((condition) => (condition.id === id ? next : condition)),
    });
  };

  const removeCondition = (id: string): void => {
    onChange({ ...form, conditions: form.conditions.filter((condition) => condition.id !== id) });
  };

  const addCondition = (): void => {
    onChange({
      ...form,
      // `crypto.randomUUID` only keys the React row; it is never persisted.
      conditions: [...form.conditions, newWebhookFormCondition(crypto.randomUUID())],
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {form.conditions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('webhooks.filter.empty')}</p>
      ) : (
        <>
          {form.conditions.length > 1 ? (
            <SelectField
              label={t('webhooks.filter.combinator')}
              value={form.combinator}
              onChange={(value) => onChange({ ...form, combinator: value === 'any' ? 'any' : 'all' })}
              options={[
                { value: 'all', label: t('webhooks.filter.combinator.all') },
                { value: 'any', label: t('webhooks.filter.combinator.any') },
              ]}
            />
          ) : null}

          <ul className="flex flex-col gap-3">
            {form.conditions.map((condition) => (
              <li key={condition.id}>
                <ConditionRow
                  condition={condition}
                  onChange={(next) => setCondition(condition.id, next)}
                  onRemove={() => removeCondition(condition.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <div>
        <Button variant="outline" onClick={addCondition}>
          <AddIcon aria-hidden />
          {t('webhooks.filter.add')}
        </Button>
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  readonly condition: WebhookFormCondition;
  readonly onChange: (next: WebhookFormCondition) => void;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const incomplete = !isWebhookFormConditionComplete(condition);

  return (
    <Surface className="flex flex-col gap-field-gap p-3">
      <div className="flex items-end gap-2">
        <SelectField
          className="flex-1"
          label={t('webhooks.filter.conditionLabel')}
          value={condition.kind}
          onChange={(value) => onChange({ ...condition, kind: value as WebhookFormConditionKind })}
          options={WEBHOOK_FORM_CONDITION_KINDS.map((kind) => ({
            value: kind,
            label: t(CONDITION_LABEL_KEYS[kind]),
          }))}
        />
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t('webhooks.filter.remove')}>
          <CloseIcon aria-hidden />
        </Button>
      </div>

      {condition.kind === 'quantity' ? (
        <QuantityCondition condition={condition} onChange={onChange} />
      ) : (
        <IdListCondition condition={condition} onChange={onChange} />
      )}

      {incomplete ? <p className="text-xs text-muted-foreground">{t('webhooks.filter.incomplete')}</p> : null}
    </Surface>
  );
}

function QuantityCondition({
  condition,
  onChange,
}: {
  readonly condition: WebhookFormCondition;
  readonly onChange: (next: WebhookFormCondition) => void;
}) {
  const t = useT();
  const valueId = useId();

  return (
    <div className="flex flex-wrap items-end gap-2">
      <SelectField
        className="min-w-40 flex-1"
        label={t('webhooks.filter.op')}
        value={condition.op}
        onChange={(value) => onChange({ ...condition, op: value as WebhookFilterOp })}
        options={WEBHOOK_FILTER_OPS.map((op) => ({ value: op, label: t(OP_LABEL_KEYS[op]) }))}
      />
      <div className="min-w-32 flex-1">
        <label htmlFor={valueId} className="mb-field-gap-compact block text-xs text-muted-foreground">
          {t('webhooks.filter.quantityValue')}
        </label>
        <Input
          id={valueId}
          inputMode="decimal"
          value={condition.value}
          onChange={(event) => onChange({ ...condition, value: event.currentTarget.value })}
        />
      </div>
    </div>
  );
}

/**
 * The id-list kinds. Values are added one at a time from a `Select` and shown as removable chips —
 * the ids themselves are never typed by hand, so a filter cannot reference something that does not
 * exist.
 */
function IdListCondition({
  condition,
  onChange,
}: {
  readonly condition: WebhookFormCondition;
  readonly onChange: (next: WebhookFormCondition) => void;
}) {
  const t = useT();
  const locations = useLocations();
  const categories = useCategories();
  const tags = useTagDictionary();

  const options: readonly { readonly value: string; readonly label: string }[] =
    condition.kind === 'location'
      ? (locations.data?.rows ?? []).map((row) => ({ value: row.id, label: row.name }))
      : condition.kind === 'category'
        ? (categories.data?.rows ?? []).map((row) => ({ value: row.id, label: row.name }))
        : (tags.data?.rows ?? []).map((row) => ({ value: row.id, label: row.name }));

  const selected = new Set(condition.ids);
  const available = options.filter((option) => !selected.has(option.value));
  const labelFor = (id: string): string => options.find((option) => option.value === id)?.label ?? id;

  return (
    <div className="flex flex-col gap-field-gap-compact">
      <Select
        value=""
        placeholder={t('webhooks.filter.addValue')}
        aria-label={t('webhooks.filter.addValue')}
        options={available}
        onChange={(value) => {
          if (value !== '') onChange({ ...condition, ids: [...condition.ids, value] });
        }}
      />

      {condition.ids.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {condition.ids.map((id) => (
            <li key={id}>
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                {labelFor(id)}
                <button
                  type="button"
                  aria-label={t('webhooks.filter.removeValue', { vars: { name: labelFor(id) } })}
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    onChange({ ...condition, ids: condition.ids.filter((entry) => entry !== id) })
                  }
                >
                  <CloseIcon aria-hidden className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {condition.kind === 'location' ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={condition.includeDescendants}
            onChange={(event) => onChange({ ...condition, includeDescendants: event.currentTarget.checked })}
          />
          {t('webhooks.filter.includeDescendants')}
        </label>
      ) : null}
    </div>
  );
}
