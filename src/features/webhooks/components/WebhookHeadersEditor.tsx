/**
 * Extra static request headers for a subscription (webhooks plan §4.1, §6.4).
 *
 * The interesting part is the validation, and *where* it happens. The bridge already refuses to
 * send a header a subscription may not set — `authorization`, `cookie`, the `x-gubbins-*` family
 * the deliverer computes — but it refuses at **send** time, which the user experiences as their
 * header simply not arriving at the receiver.
 *
 * So the same rule is checked here as the name is typed, against the very same list: `headers.ts`
 * lives in `src/` and the bridge imports it back. A name that would be dropped is called out
 * immediately, with *which* rule it breaks, rather than being discovered at the far end of a
 * delivery that otherwise looks successful.
 */
import { useId } from 'react';
import { Button, Input, Surface } from '@/components/foundry';
import { AddIcon, CloseIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { webhookHeaderIssue, type WebhookHeaderIssue } from '../headers';
import type { WebhookHeaderRow } from '../header-rows';

const ISSUE_KEYS = {
  empty: 'webhooks.headers.issue.empty',
  reserved: 'webhooks.headers.issue.reserved',
  forbidden: 'webhooks.headers.issue.forbidden',
} as const satisfies Record<WebhookHeaderIssue, MessageKey>;

export interface WebhookHeadersEditorProps {
  readonly rows: readonly WebhookHeaderRow[];
  readonly onChange: (next: readonly WebhookHeaderRow[]) => void;
}

export function WebhookHeadersEditor({ rows, onChange }: WebhookHeadersEditorProps) {
  const t = useT();

  const setRow = (id: string, next: Partial<WebhookHeaderRow>): void => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('webhooks.headers.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <HeaderRow
                row={row}
                onChange={(next) => setRow(row.id, next)}
                onRemove={() => onChange(rows.filter((entry) => entry.id !== row.id))}
              />
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          variant="outline"
          onClick={() =>
            // The id only keys the React row; it is never persisted.
            onChange([...rows, { id: crypto.randomUUID(), name: '', value: '' }])
          }
        >
          <AddIcon aria-hidden />
          {t('webhooks.headers.add')}
        </Button>
      </div>
    </div>
  );
}

function HeaderRow({
  row,
  onChange,
  onRemove,
}: {
  readonly row: WebhookHeaderRow;
  readonly onChange: (next: Partial<WebhookHeaderRow>) => void;
  readonly onRemove: () => void;
}) {
  const t = useT();
  const nameId = useId();
  const valueId = `${nameId}-value`;
  const errorId = `${nameId}-error`;

  const issue = row.name.trim() === '' ? null : webhookHeaderIssue(row.name);

  return (
    <Surface className="flex flex-col gap-field-gap-compact p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1">
          <label htmlFor={nameId} className="mb-field-gap-compact block text-xs text-muted-foreground">
            {t('webhooks.headers.name')}
          </label>
          <Input
            id={nameId}
            value={row.name}
            placeholder="X-Source"
            aria-invalid={issue !== null}
            aria-describedby={issue === null ? undefined : errorId}
            onChange={(event) => onChange({ name: event.currentTarget.value })}
          />
        </div>
        <div className="min-w-40 flex-1">
          <label htmlFor={valueId} className="mb-field-gap-compact block text-xs text-muted-foreground">
            {t('webhooks.headers.value')}
          </label>
          <Input
            id={valueId}
            value={row.value}
            onChange={(event) => onChange({ value: event.currentTarget.value })}
          />
        </div>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t('webhooks.headers.remove')}>
          <CloseIcon aria-hidden />
        </Button>
      </div>

      {issue !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {t(ISSUE_KEYS[issue])}
        </p>
      ) : null}
    </Surface>
  );
}
