/**
 * Pure "visible card fields" model (backlog E1 — configurable item-card fields + order).
 *
 * The inventory item card/row shows a user-chosen, user-ordered set of attributes
 * (location, category, condition, total value, quantity, last-updated, plus any of the
 * category custom fields). This seam owns the whole model as side-effect-free functions,
 * mirroring the sibling pure seams (`reorder-policy.ts`, `custom-fields.ts`,
 * `dashboard-layout.ts`): the persisted preference holds the user's *intent* and this
 * resolves it against the live custom-field catalog on read (so a stale/renamed/removed
 * field can never reach the renderer), reorders/toggles it, and turns one item into the
 * ordered list of `{ label, value }` the card component draws. No React, no DB — the whole
 * thing is exhaustively unit-testable.
 */
import type { Item } from '@/db/repositories';
import type { Condition, FieldType } from '@/db/repositories/constants';
import { isImageDataUrl } from '@/lib/image-data-url';
import { UNLIMITED_GLYPH } from './unlimited';

/** The built-in (always-available) card fields — those derivable from the item row itself. */
export type BuiltinCardFieldId =
  'location' | 'category' | 'condition' | 'value' | 'quantity' | 'updated' | 'tags';

export interface BuiltinCardField {
  readonly id: BuiltinCardFieldId;
  /** The picker + card label for this field. */
  readonly label: string;
}

/**
 * The built-in card fields offered by the picker, in canonical order (the order a
 * newly-added built-in appends in, and the order the "reset" restores). This is the SSOT
 * for the built-in labels — the resolver and the picker both read them from here.
 */
export const BUILTIN_CARD_FIELDS: readonly BuiltinCardField[] = [
  { id: 'location', label: 'Location' },
  { id: 'category', label: 'Category' },
  { id: 'condition', label: 'Condition' },
  { id: 'value', label: 'Total value' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'updated', label: 'Last updated' },
  { id: 'tags', label: 'Tags' },
];

const BUILTIN_LABELS = new Map<string, string>(BUILTIN_CARD_FIELDS.map((f) => [f.id, f.label]));

/** The label for a built-in card field id, or undefined if the id isn't a built-in. */
export function builtinCardFieldLabel(id: string): string | undefined {
  return BUILTIN_LABELS.get(id);
}

/**
 * Prefix namespacing a category custom-field id when it is used as a card-field id, so a
 * field UUID can never collide with a built-in id (`custom:<fieldUuid>`).
 */
export const CUSTOM_FIELD_PREFIX = 'custom:';

/**
 * Wrap a category custom-field id as a card-field id.
 *
 * @internal Exported for unit tests only.
 */
export function customCardFieldId(fieldId: string): string {
  return `${CUSTOM_FIELD_PREFIX}${fieldId}`;
}

/** Unwrap a card-field id back to its category custom-field id, or null if it isn't one. */
export function parseCustomCardFieldId(id: string): string | null {
  return id.startsWith(CUSTOM_FIELD_PREFIX) ? id.slice(CUSTOM_FIELD_PREFIX.length) : null;
}

/** One field's place in the card: its id and whether it is shown. */
export interface CardFieldSetting {
  readonly id: string;
  readonly visible: boolean;
}

/** The ordered, per-device card-field configuration (the Tier-2 preference's shape). */
export type CardFieldsConfig = readonly CardFieldSetting[];

/**
 * The shipped default — Location and Category shown (matching the card's historic
 * location line plus one high-value addition), every other built-in available but hidden.
 * Custom fields are appended (hidden) at resolve time from the live catalog.
 */
export const DEFAULT_CARD_FIELDS: CardFieldsConfig = [
  { id: 'location', visible: true },
  { id: 'category', visible: true },
  { id: 'condition', visible: false },
  { id: 'value', visible: false },
  { id: 'quantity', visible: false },
  { id: 'updated', visible: false },
  { id: 'tags', visible: false },
];

/**
 * Reconcile a persisted config against the live custom-field catalog (resolve-on-read,
 * mirroring the modular-ui / nav-count "store intent, resolve effective" pattern). The
 * result is always complete and valid:
 *
 * - Saved entries in a still-valid order/visibility are kept (a built-in, or a custom
 *   field whose id is still in `customFieldIds`).
 * - Stale entries — a removed custom field, or garbage from an older/newer build — are
 *   dropped so they can never reach the renderer or the picker.
 * - Every built-in is guaranteed present (a built-in added in a later build appends hidden).
 * - Every currently-available custom field is guaranteed present (a newly-created field
 *   appends hidden, so the user can opt into it without it appearing unbidden).
 *
 * A corrupt/absent `saved` (not an array) falls back to {@link DEFAULT_CARD_FIELDS}, so a
 * fresh install lands on the shipped default.
 */
export function normaliseCardFields(saved: unknown, customFieldIds: readonly string[]): CardFieldsConfig {
  const customSet = new Set(customFieldIds);
  const seen = new Set<string>();
  const out: CardFieldSetting[] = [];
  const push = (id: string, visible: boolean) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, visible });
    }
  };

  const source = Array.isArray(saved) ? saved : DEFAULT_CARD_FIELDS;
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    const visible = (entry as { visible?: unknown }).visible;
    if (typeof id !== 'string' || typeof visible !== 'boolean') continue;
    const customId = parseCustomCardFieldId(id);
    const known = BUILTIN_LABELS.has(id) || (customId !== null && customSet.has(customId));
    if (!known) continue;
    push(id, visible);
  }

  // Guarantee every built-in and every available custom field appears (hidden if the
  // saved config predates it), so the picker always lists the full, current field set.
  for (const f of BUILTIN_CARD_FIELDS) push(f.id, false);
  for (const fieldId of customFieldIds) push(customCardFieldId(fieldId), false);

  return out;
}

/** The visible field ids, in order — the input the card renderer iterates. */
export function visibleCardFieldIds(config: CardFieldsConfig): string[] {
  return config.filter((f) => f.visible).map((f) => f.id);
}

/**
 * The shipped-default visible field ids (`['location', 'category']`) as a stable module
 * constant, so a card/row rendered without an explicit config (e.g. a test, or before the
 * preference has resolved) still shows a sensible set without allocating on every render.
 */
export const DEFAULT_VISIBLE_CARD_FIELD_IDS: readonly string[] = visibleCardFieldIds(DEFAULT_CARD_FIELDS);

/**
 * Move a field one slot up or down. Returns the same reference on a no-op (unknown id, or
 * already at the end in that direction) so a store setter can skip a pointless write — the
 * same contract as the pure `dashboard-layout.ts` ops.
 */
export function moveCardField(config: CardFieldsConfig, id: string, dir: 'up' | 'down'): CardFieldsConfig {
  const i = config.findIndex((f) => f.id === id);
  if (i < 0) return config;
  const j = dir === 'up' ? i - 1 : i + 1;
  const a = config[i];
  const b = config[j];
  if (a === undefined || b === undefined) return config; // out of range in that direction
  const next = config.slice();
  next[i] = b;
  next[j] = a;
  return next;
}

/** Show or hide a field. Returns the same reference on a no-op (unknown id, or unchanged). */
export function setCardFieldVisible(
  config: CardFieldsConfig,
  id: string,
  visible: boolean,
): CardFieldsConfig {
  const i = config.findIndex((f) => f.id === id);
  const current = config[i];
  if (current === undefined || current.visible === visible) return config;
  const next = config.slice();
  next[i] = { ...current, visible };
  return next;
}

// --- Rendering model -------------------------------------------------------------

/**
 * The subset of a category custom-field definition the card needs to render one field —
 * enough to label it, decide whether it applies to a given item (`categoryId`), and format
 * the raw stored value (`fieldType`) with lenient defaulting (`defaultValue`).
 */
export interface CardCustomField {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly fieldType: FieldType;
  readonly defaultValue: string | null;
}

/**
 * A resolved field's value, as a token-agnostic descriptor the card maps to JSX — kept out
 * of this pure seam so money keeps using the Foundry `Money` control and a condition keeps
 * its `text-cond-*` tint (design-token house rules) rather than a pre-formatted string.
 * `empty` renders as a muted em-dash, keeping every card the same height for a given config.
 */
export type CardFieldValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'money'; readonly amount: number }
  | { readonly kind: 'condition'; readonly condition: Condition }
  | { readonly kind: 'tags'; readonly tags: readonly string[] }
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'empty' };

export interface ResolvedCardField {
  readonly id: string;
  readonly label: string;
  readonly value: CardFieldValue;
}

const EMPTY: CardFieldValue = { kind: 'empty' };

/** The formatter functions the resolver needs (a pure subset of `useFormatters`). */
export interface CardFieldFormatters {
  readonly quantity: (n: number) => string;
  readonly relativeTime: (ms: number) => string;
}

/** Everything a card needs to resolve its fields for one item (the per-item + shared bits). */
export interface CardFieldContext {
  /** The item's resolved location name (already looked up by the list). */
  readonly locationName: string;
  /** The item's resolved category name, or null when it has no category. */
  readonly categoryName: string | null;
  /** The live custom-field catalog, keyed by field id (stable across the list). */
  readonly customFields: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values (fieldId → raw value), if they've loaded. */
  readonly customValues: ReadonlyMap<string, string> | undefined;
  /** This item's tag names (issue #84), if the Tags field is shown and they've loaded. */
  readonly tags?: readonly string[];
  readonly fmt: CardFieldFormatters;
}

/**
 * Resolve one item's visible fields (an ordered list of ids) into the label/value
 * descriptors the card renders — always one entry per id (an inapplicable or unset field
 * resolves to `empty`), so a card's height depends only on the configuration, not the item.
 */
export function resolveCardFields(
  order: readonly string[],
  item: Item,
  ctx: CardFieldContext,
): ResolvedCardField[] {
  const out: ResolvedCardField[] = [];
  for (const id of order) {
    const resolved = resolveOne(id, item, ctx);
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

function resolveOne(id: string, item: Item, ctx: CardFieldContext): ResolvedCardField | null {
  const customId = parseCustomCardFieldId(id);
  if (customId !== null) {
    const field = ctx.customFields.get(customId);
    if (field === undefined) return null; // stale id — normalisation should have dropped it
    // A custom field applies only to items in its own category; for any other item the
    // line still renders (as em-dash) so cards keep a uniform height.
    if (item.categoryId !== field.categoryId) return { id, label: field.name, value: EMPTY };
    const raw = ctx.customValues?.get(customId) ?? field.defaultValue;
    return { id, label: field.name, value: customFieldValue(field.fieldType, raw) };
  }

  switch (id) {
    case 'location':
      return { id, label: 'Location', value: { kind: 'text', text: ctx.locationName } };
    case 'category':
      return {
        id,
        label: 'Category',
        value: ctx.categoryName ? { kind: 'text', text: ctx.categoryName } : EMPTY,
      };
    case 'condition':
      return {
        id,
        label: 'Condition',
        value: item.condition ? { kind: 'condition', condition: item.condition } : EMPTY,
      };
    case 'value': {
      // Total value = unit cost × on-hand count, so it needs a *real* count. An unlimited
      // item's quantity is ∞-ignored and a gauge tracks a measure (not units), so for either
      // the product is meaningless (it would read £0.00) — show em-dash, matching how the
      // `quantity` field itself declines to show those (see {@link quantityValue}).
      const countable = !item.isUnlimited && item.trackingMode !== 'CONSUMABLE_GAUGE';
      const priced = countable && item.unitCost != null && Number.isFinite(item.unitCost);
      return {
        id,
        label: 'Total value',
        value: priced ? { kind: 'money', amount: item.unitCost! * item.quantity } : EMPTY,
      };
    }
    case 'quantity':
      return { id, label: 'Quantity', value: quantityValue(item, ctx.fmt) };
    case 'updated':
      return {
        id,
        label: 'Last updated',
        value: { kind: 'text', text: ctx.fmt.relativeTime(item.updatedAt) },
      };
    case 'tags': {
      // Issue #84: the item's freeform tags, rendered as chips by the card. Fetched per
      // on-screen window (like custom-field values), so an item whose tags haven't loaded —
      // or that has none — resolves to em-dash, keeping card heights config-driven.
      const tags = ctx.tags ?? [];
      return { id, label: 'Tags', value: tags.length > 0 ? { kind: 'tags', tags } : EMPTY };
    }
    default:
      return null; // unknown built-in id (defensive — normalisation drops these)
  }
}

/** The quantity field: ∞ for an unlimited item, em-dash for a gauge (its measure shows elsewhere), else the count. */
function quantityValue(item: Item, fmt: CardFieldFormatters): CardFieldValue {
  if (item.isUnlimited) return { kind: 'text', text: UNLIMITED_GLYPH };
  if (item.trackingMode === 'CONSUMABLE_GAUGE') return EMPTY;
  return { kind: 'text', text: fmt.quantity(item.quantity) };
}

/**
 * Format a raw stored custom-field value by type; a blank/absent value is em-dash.
 *
 * Shared with the location detail panel (`location-detail.ts`), so a custom field reads the same
 * whether it is a fact about an item or about the place it sits in (issue #617).
 */
export function customFieldValue(type: FieldType, raw: string | null): CardFieldValue {
  if (raw === null || raw.trim() === '') return EMPTY;
  if (type === 'BOOLEAN') return { kind: 'text', text: raw.toLowerCase() === 'true' ? 'Yes' : 'No' };
  if (type === 'ON_OFF') return { kind: 'text', text: raw.toLowerCase() === 'true' ? 'On' : 'Off' };
  // An IMAGE value is an image `data:` URL — render it as a thumbnail, not its base64 text.
  // Only a value of exactly that shape becomes a `src` (see {@link isImageDataUrl}); anything
  // else is em-dash, so a stored string can never become a URL the card fetches. Tested (and
  // shown) trimmed, so this accepts exactly what saving does — validation trims first.
  if (type === 'IMAGE') {
    const trimmed = raw.trim();
    return isImageDataUrl(trimmed) ? { kind: 'image', src: trimmed } : EMPTY;
  }
  return { kind: 'text', text: raw };
}
