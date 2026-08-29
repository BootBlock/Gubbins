/**
 * Pure rendering of the before/after values an Activity Log entry recorded (issue #486).
 *
 * `describeHistoryEntry` parses `metadata.changes` into `{field, from, to}` records; this module
 * turns one such value into something a person reads. The ledger stores what a machine needs —
 * `4.5`, `1804204800000`, a category's UUID — so without this the audit trail is legible only to
 * whoever knows what each column means.
 *
 * Every rule comes from the {@link AuditedItemField} `kind` in the shared registry, so a field
 * added to the audit is formatted correctly by construction rather than by a second list kept in
 * step by hand. Money is returned as a **number** rather than a string: the Foundry `Money`
 * primitive is the canonical way to render a price, and it tints the currency symbol apart from
 * the digits, which a pre-formatted string cannot.
 *
 * Pure — no React, no DOM, no clock. The locale-bound bits arrive as a {@link Formatters} bundle
 * and the copy as already-translated strings, exactly as `bulk-edit.ts` takes its lookups.
 */
import type { Condition, TrackingMode } from '@/db/repositories';
import type { Formatters } from '@/lib/format';
import { auditedItemField, type ItemFieldValueKind } from './audited-item-fields';
import type { HistoryChangeValue, HistoryFieldChange } from './history-format';
import { CONDITION_LABELS, TRACKING_MODE_LABELS } from './components/inventory-ui';

/** What one recorded value renders as: a price the `Money` primitive paints, or plain text. */
export type ChangeValueView =
  { readonly kind: 'money'; readonly value: number } | { readonly kind: 'text'; readonly text: string };

/** The locale-bound formatting and copy one change needs, supplied by the calling component. */
export interface ChangeFormatContext {
  /** The user's locale/currency/unit-bound formatters (`useFormatters`). */
  readonly formatters: Formatters;
  /** A category id resolved to its name, or `null` when this build has never seen that id. */
  readonly categoryName: (id: string) => string | null;
  /** Translated copy for a value the entry recorded as absent (`null`). */
  readonly notSet: string;
  /** Translated copy for a category id that no longer resolves to a category. */
  readonly unknownCategory: string;
}

/** Both sides of one change, ready to render, with the field's translated label resolved. */
export interface ChangeRowView {
  readonly field: string;
  /** The sentence-case field label, e.g. "Unit cost". */
  readonly label: string;
  readonly from: ChangeValueView;
  readonly to: ChangeValueView;
}

const text = (value: string): ChangeValueView => ({ kind: 'text', text: value });

/**
 * A day-grained ISO calendar date (`YYYY-MM-DD`) as UTC midnight, or `null` if it is not one.
 *
 * Parsed here rather than with `Date.parse` on the whole string so a malformed value from a peer
 * degrades to its raw text instead of to "Invalid Date".
 */
function isoDateToUtcMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One recorded value, formatted for its field's {@link ItemFieldValueKind}.
 *
 * A value whose runtime type does not match its kind falls through to its raw text rather than
 * being dropped or rendered as `NaN`. That is not defensive padding: `item_history` unions across
 * devices (§7.3), so an entry written by a peer on a different schema version can carry a number
 * where this build expects a string. The ledger is immutable, so showing what it actually says is
 * the only honest option.
 */
export function formatChangeValue(
  kind: ItemFieldValueKind,
  value: HistoryChangeValue,
  ctx: ChangeFormatContext,
): ChangeValueView {
  if (value === null) return text(ctx.notSet);
  const { formatters: fmt } = ctx;

  switch (kind) {
    case 'money':
      return typeof value === 'number' && Number.isFinite(value)
        ? { kind: 'money', value }
        : text(String(value));
    case 'count':
      return typeof value === 'number' ? text(fmt.quantity(value)) : text(String(value));
    case 'percent':
      // Stored 0..100 (the reorder gauge floor); `fmt.percent` takes a 0..1 ratio.
      return typeof value === 'number' ? text(fmt.percent(value / 100)) : text(String(value));
    case 'weight':
      return typeof value === 'number' ? text(fmt.weight(value)) : text(String(value));
    case 'dimension':
      return typeof value === 'number' ? text(fmt.dimension(value)) : text(String(value));
    case 'timestamp':
      // Day-grained instants written at midnight UTC, so `calendarDate` — `date` renders in the
      // host zone and would slip an expiry to the previous day west of Greenwich.
      return typeof value === 'number' && Number.isFinite(value)
        ? text(fmt.calendarDate(value))
        : text(String(value));
    case 'isoDate': {
      const ms = typeof value === 'string' ? isoDateToUtcMs(value) : null;
      return ms === null ? text(String(value)) : text(fmt.calendarDate(ms));
    }
    case 'category':
      return typeof value === 'string'
        ? text(ctx.categoryName(value) ?? ctx.unknownCategory)
        : text(String(value));
    case 'trackingMode':
      return text(TRACKING_MODE_LABELS[value as TrackingMode] ?? String(value));
    case 'condition':
      return text(CONDITION_LABELS[value as Condition] ?? String(value));
    case 'text':
      return text(String(value));
  }
}

/**
 * One `{field, from, to}` record ready for the row to render.
 *
 * A field this build does not know is still shown — with its raw camelCase name as the label and
 * both values as plain text. A newer peer's entry is a true record of something that happened, so
 * hiding it would leave a gap in the audit trail exactly where the log is least able to explain
 * itself.
 */
export function describeChange(
  change: HistoryFieldChange,
  ctx: ChangeFormatContext,
  label: (field: string) => string,
): ChangeRowView {
  const kind = auditedItemField(change.field)?.kind ?? 'text';
  return {
    field: change.field,
    label: label(change.field),
    from: formatChangeValue(kind, change.from, ctx),
    to: formatChangeValue(kind, change.to, ctx),
  };
}
