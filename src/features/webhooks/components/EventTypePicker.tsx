/**
 * The grouped event picker (webhooks plan `W7`; see §5.1).
 *
 * Built entirely from `EVENT_CATALOGUE` — the hand-written, human-readable half of the event
 * vocabulary that `W2` produced for exactly this screen. Nothing here re-describes an event:
 * the label, the description and the group all come from the catalogue, so a new event type
 * appears in this picker the moment it is catalogued, and cannot appear before it is explained.
 *
 * Two entries are deliberately not treated like the rest:
 *
 * - **`lookup.resolved` is marked sensitive** and never pre-selected. Every other event describes a
 *   change the user made to their own data; this one publishes *what somebody searched for*. The
 *   bridge already gates it behind its own separate opt-in, and pre-ticking it here would quietly
 *   undo that.
 * - **`events.truncated` is diagnostic** — emitted by the machinery rather than chosen. Offered,
 *   because a subscriber genuinely needs to know it can arrive, but never assumed.
 */
import { useId } from 'react';
import { useT, type MessageKey } from '@/features/i18n';
import { Checkbox } from '@/components/foundry';
import {
  eventCatalogueByGroup,
  type EventCatalogueEntry,
  type EventGroup,
} from '@/features/events/event-catalogue';
import { WEBHOOK_ALL_EVENTS } from '../subscription';

export interface EventTypePickerProps {
  /** The subscribed types, or `['*']` for every event. */
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}

/** i18n keys for the group headings, which the catalogue groups by. */
const GROUP_LABEL_KEYS = {
  lifecycle: 'events.group.lifecycle',
  stock: 'events.group.stock',
  movement: 'events.group.movement',
  places: 'events.group.places',
  custody: 'events.group.custody',
  upkeep: 'events.group.upkeep',
  system: 'events.group.system',
} as const satisfies Record<EventGroup, MessageKey>;

export function EventTypePicker({ value, onChange }: EventTypePickerProps) {
  const t = useT();
  const allId = useId();
  const allHintId = `${allId}-hint`;
  const groups = eventCatalogueByGroup();
  const allEvents = value.includes(WEBHOOK_ALL_EVENTS);
  const selected = new Set(value);

  const toggleAll = (checked: boolean): void => {
    // Switching off "every event" leaves nothing selected rather than guessing which subset the
    // user meant — the form's own validation then asks them to choose, which is honest.
    onChange(checked ? [WEBHOOK_ALL_EVENTS] : []);
  };

  const toggleType = (type: string, checked: boolean): void => {
    const next = new Set(value.filter((entry) => entry !== WEBHOOK_ALL_EVENTS));
    if (checked) next.add(type);
    else next.delete(type);
    onChange([...next]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Checkbox
          id={allId}
          aria-describedby={allHintId}
          checked={allEvents}
          onChange={(event) => toggleAll(event.currentTarget.checked)}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-field-gap-compact">
          <label htmlFor={allId} className="text-sm font-medium text-foreground">
            {t('webhooks.events.all')}
          </label>
          <span id={allHintId} className="text-xs text-muted-foreground">
            {t('webhooks.events.allHint')}
          </span>
        </div>
      </div>

      {groups.map(({ group, entries }) => (
        <fieldset key={group} className="flex flex-col gap-field-gap-compact" disabled={allEvents}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(GROUP_LABEL_KEYS[group])}
          </legend>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <EventTypeRow
                key={entry.type}
                entry={entry}
                checked={allEvents || selected.has(entry.type)}
                disabled={allEvents}
                onToggle={(checked) => toggleType(entry.type, checked)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function EventTypeRow({
  entry,
  checked,
  disabled,
  onToggle,
}: {
  readonly entry: EventCatalogueEntry;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (checked: boolean) => void;
}) {
  const t = useT();
  const rowId = useId();
  const descriptionId = `${rowId}-description`;

  return (
    // The label names the event (plus any badge, which is worth hearing); the "when this fires"
    // copy is referenced rather than nested, so the checkbox's accessible name stays the event
    // itself instead of a paragraph.
    <div className="flex items-start gap-3">
      <Checkbox
        id={rowId}
        aria-describedby={descriptionId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.currentTarget.checked)}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-field-gap-compact">
        <label htmlFor={rowId} className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-foreground">{t(entry.labelKey)}</span>
          {entry.sensitive === true ? (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              {t('webhooks.events.sensitive')}
            </span>
          ) : null}
          {entry.diagnostic === true ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('webhooks.events.diagnostic')}
            </span>
          ) : null}
        </label>
        <span id={descriptionId} className="text-xs text-muted-foreground">
          {t(entry.descriptionKey)}
        </span>
      </div>
    </div>
  );
}
