/**
 * The editable form model behind the filter builder, and its round-trip to
 * {@link WebhookFilter} (webhooks plan `W7`; see §5.2).
 *
 * Pure and separate from the component so the conversion — the part with actual decisions in it —
 * is unit-testable, and so the builder never hand-assembles filter nodes at a call site.
 *
 * ## The builder edits a subset, and admits it
 *
 * `WebhookFilter` is a full tree: `all` / `any` / `not` / `none` combinators nesting to any depth.
 * The builder offers the shape people actually want — **one combinator over a flat list of leaf
 * conditions** — because a general tree editor is a query builder, and a query builder is a worse
 * way to say "anything in the shed" than a list with a dropdown on top.
 *
 * Everything else still round-trips safely. {@link webhookFilterToForm} returns `null` for a filter
 * this model cannot represent — a nested tree, a `not`, an inert `none`, or an `item` leaf — and the
 * builder then shows that filter **read-only** rather than editing it. That is the important half:
 * these rows arrive over sync from peers on other builds, and quietly rewriting a filter the editor
 * did not fully understand would change what a subscription delivers without anyone asking for it.
 */
import type { WebhookFilter, WebhookFilterOp } from './filter';

/** The leaf kinds the builder can create. See the module note on why `item` is not among them. */
export const WEBHOOK_FORM_CONDITION_KINDS = ['location', 'category', 'tag', 'quantity'] as const;
export type WebhookFormConditionKind = (typeof WEBHOOK_FORM_CONDITION_KINDS)[number];

/** How the conditions combine. The tree supports more; the builder offers these two. */
export type WebhookFormCombinator = 'all' | 'any';

/**
 * One editable row. A single shape covers every kind rather than a union, because the row's kind is
 * a dropdown the user changes in place — carrying the other kinds' fields across that change is
 * what makes switching kind and switching back non-destructive.
 */
export interface WebhookFormCondition {
  /** Local-only React key. Never persisted. */
  readonly id: string;
  readonly kind: WebhookFormConditionKind;
  /** Selected ids for the id-list kinds (`location` / `category` / `tag`). */
  readonly ids: readonly string[];
  /** `location` only — "the shed" almost always means "and everything in it". */
  readonly includeDescendants: boolean;
  /** `quantity` only. */
  readonly op: WebhookFilterOp;
  /** `quantity` only, held as text so a half-typed value does not collapse to 0. */
  readonly value: string;
}

export interface WebhookFilterForm {
  readonly combinator: WebhookFormCombinator;
  readonly conditions: readonly WebhookFormCondition[];
}

/** A blank form — "no filter", i.e. every event of the subscribed types. */
export function emptyWebhookFilterForm(): WebhookFilterForm {
  return { combinator: 'all', conditions: [] };
}

/** A new row, defaulted to the most common condition people reach for. */
export function newWebhookFormCondition(id: string): WebhookFormCondition {
  return { id, kind: 'location', ids: [], includeDescendants: true, op: 'lte', value: '' };
}

/**
 * Read a stored filter into the form model, or `null` when the builder cannot represent it.
 *
 * `null` is not an error — it is the signal to show the filter read-only. See the module note.
 */
export function webhookFilterToForm(filter: WebhookFilter | null): WebhookFilterForm | null {
  if (filter === null) return emptyWebhookFilterForm();

  if (filter.kind === 'all' || filter.kind === 'any') {
    const conditions: WebhookFormCondition[] = [];
    for (const [index, child] of filter.of.entries()) {
      const condition = leafToCondition(child, `stored-${String(index)}`);
      if (condition === null) return null; // a nested or unsupported child — not representable
      conditions.push(condition);
    }
    return { combinator: filter.kind, conditions };
  }

  const single = leafToCondition(filter, 'stored-0');
  if (single === null) return null;
  return { combinator: 'all', conditions: [single] };
}

/**
 * Build the filter a form describes, or `null` for "no filter".
 *
 * Rows that carry nothing usable — an id-list with no ids selected, a quantity with no number — are
 * **dropped rather than emitted**. An empty `location` leaf would match nothing at all, silently
 * turning a half-finished row into a subscription that never fires.
 */
export function formToWebhookFilter(form: WebhookFilterForm): WebhookFilter | null {
  const leaves: WebhookFilter[] = [];
  for (const condition of form.conditions) {
    const leaf = conditionToLeaf(condition);
    if (leaf !== null) leaves.push(leaf);
  }

  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!;
  return { kind: form.combinator, of: leaves };
}

/** Whether a row would contribute anything — used to warn before it is silently dropped. */
export function isWebhookFormConditionComplete(condition: WebhookFormCondition): boolean {
  return conditionToLeaf(condition) !== null;
}

function leafToCondition(filter: WebhookFilter, id: string): WebhookFormCondition | null {
  const base = {
    id,
    ids: [] as readonly string[],
    includeDescendants: true,
    op: 'lte' as WebhookFilterOp,
    value: '',
  };

  switch (filter.kind) {
    case 'location':
      return {
        ...base,
        kind: 'location',
        ids: filter.locationIds,
        includeDescendants: filter.includeDescendants ?? true,
      };
    case 'category':
      return { ...base, kind: 'category', ids: filter.categoryIds };
    case 'tag':
      return { ...base, kind: 'tag', ids: filter.tagIds };
    case 'quantity':
      return { ...base, kind: 'quantity', op: filter.op, value: String(filter.value) };
    default:
      // `all` / `any` (nested), `not`, `none` and `item` — deliberately not representable.
      return null;
  }
}

function conditionToLeaf(condition: WebhookFormCondition): WebhookFilter | null {
  if (condition.kind === 'quantity') {
    const value = Number(condition.value.trim());
    if (condition.value.trim() === '' || !Number.isFinite(value)) return null;
    return { kind: 'quantity', op: condition.op, value };
  }

  const ids = condition.ids.filter((id) => id.trim() !== '');
  if (ids.length === 0) return null;

  switch (condition.kind) {
    case 'location':
      return { kind: 'location', locationIds: ids, includeDescendants: condition.includeDescendants };
    case 'category':
      return { kind: 'category', categoryIds: ids };
    case 'tag':
      return { kind: 'tag', tagIds: ids };
  }
}
