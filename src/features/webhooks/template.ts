/**
 * The payload **template engine** — presets, the allow-listed interpolator, and `GET` query
 * flattening (webhooks plan `W3`; see `docs/todo/webhooks_2026-07-18.md` §5.3).
 *
 * What a subscription actually sends. Three shapes, in ascending order of how much the user is
 * doing themselves:
 *
 *   1. **No template (`null`) — the default.** The bridge sends its existing `BridgeEvent` envelope
 *      byte-for-byte unchanged, so everything already consuming bridge webhooks keeps working. This
 *      module never rebuilds that envelope; it returns {@link WEBHOOK_PAYLOAD_ENVELOPE}, a marker
 *      telling the deliverer to serialise the event it is already holding. Re-deriving it here
 *      would fork the payload contract in a second place and let the two drift.
 *   2. **A preset** — `preset:discord`, `preset:slack`, … A named, project-maintained projection for
 *      a receiver that expects a particular shape (Discord wants `content`, Slack wants `text`).
 *   3. **A custom template** — free text with `{{item.name}}`-style placeholders.
 *
 * ## Why interpolation cannot leak
 *
 * A placeholder resolves against {@link WEBHOOK_TEMPLATE_PATHS}: an explicit table of permitted
 * paths, each with a hand-written accessor over the closed {@link WebhookEventView}. There is no
 * property traversal, no `[]` indexing of a user-supplied key, no expression grammar, and no code
 * path that reaches an object the view does not expose. So a template **cannot** surface something
 * the event did not already contain — not the subscription's signing secret, not its headers, not
 * another item — because none of those are reachable from the only object in scope. An unknown
 * path is not an error: it renders empty, and {@link unknownTemplatePaths} reports it separately so
 * the `W7` editor can flag the typo without the deliverer having to fail a live delivery over one.
 *
 * ## `GET`
 *
 * A `GET` carries no body, so §5.3 flattens the payload into query parameters instead
 * ({@link webhookQueryParams}). Note that a `GET` therefore cannot carry an HMAC *body* signature —
 * the UI must say so, and `W5` must not pretend otherwise.
 *
 * Pure: no network, no clock, no `URL` mutation, no I/O. Imported by the bridge, so it must survive
 * Node's **strip-only** loader: no `enum`, no `namespace`, no TS parameter properties.
 */
import type { WebhookEventView } from './event-view.ts';

/** A JSON value a rendered payload may contain. */
export type WebhookJsonValue =
  string | number | boolean | null | readonly WebhookJsonValue[] | WebhookJsonObject;
export interface WebhookJsonObject {
  readonly [key: string]: WebhookJsonValue;
}

/**
 * A resolved payload, as a discriminated union so the deliverer cannot forget the envelope case.
 *
 * `envelope` deliberately carries no body: the point is that the deliverer sends the original event
 * object it already has, unchanged (see the module note).
 */
export type WebhookPayload =
  | { readonly kind: 'envelope' }
  | { readonly kind: 'json'; readonly body: WebhookJsonObject }
  | { readonly kind: 'text'; readonly body: string };

/** The marker returned for the default (no-template) case. Frozen — it is shared by every caller. */
export const WEBHOOK_PAYLOAD_ENVELOPE: WebhookPayload = Object.freeze({ kind: 'envelope' as const });

/** The prefix that marks a stored template as naming a preset rather than being one. */
export const WEBHOOK_PRESET_PREFIX = 'preset:';

/** The presets a subscription may name. */
export const WEBHOOK_PRESETS = ['discord', 'slack', 'homeAssistant', 'generic'] as const;
export type WebhookPreset = (typeof WEBHOOK_PRESETS)[number];

/** Type guard: is `value` a known preset name (the part after `preset:`)? */
export function isWebhookPreset(value: unknown): value is WebhookPreset {
  return typeof value === 'string' && (WEBHOOK_PRESETS as readonly string[]).includes(value);
}

/**
 * The allow-list: every path a `{{placeholder}}` may name, with the accessor that resolves it.
 *
 * Adding a path is a deliberate edit here — which is the security property. Each accessor returns
 * the raw value; {@link formatTemplateValue} decides how it renders, in one place, so no two paths
 * can disagree about how a `null` or a number looks.
 */
export const WEBHOOK_TEMPLATE_PATHS: Readonly<
  Record<string, (view: WebhookEventView) => string | number | null>
> = Object.freeze({
  'event.id': (view) => view.id,
  'event.type': (view) => view.type,
  'event.occurredAt': (view) => view.occurredAt,

  'item.id': (view) => view.item?.id ?? null,
  'item.name': (view) => view.item?.name ?? null,
  'item.quantity': (view) => view.item?.quantity ?? null,
  'item.locationId': (view) => view.item?.locationId ?? null,
  'item.locationName': (view) => view.item?.locationName ?? null,
  'item.categoryId': (view) => view.item?.categoryId ?? null,
  'item.categoryName': (view) => view.item?.categoryName ?? null,

  'change.action': (view) => view.change?.action ?? null,
  'change.kind': (view) => view.change?.kind ?? null,
  'change.label': (view) => view.change?.label ?? null,
  'change.detail': (view) => view.change?.detail ?? null,
  'change.delta': (view) => view.change?.delta ?? null,
  'change.quantityDelta': (view) => view.change?.quantityDelta ?? null,
  'change.netValueDelta': (view) => view.change?.netValueDelta ?? null,
});

/** Every allow-listed path, sorted — the list the `W7` template editor offers as suggestions. */
export const WEBHOOK_TEMPLATE_PATH_NAMES: readonly string[] = Object.keys(WEBHOOK_TEMPLATE_PATHS).sort();

/**
 * Matches one `{{ path }}` placeholder, tolerating surrounding whitespace.
 *
 * The path character class is restricted to word characters and dots, so a placeholder can never
 * contain a bracket, quote or brace — it cannot express indexing or nesting even syntactically,
 * which keeps "there is no expression grammar" true at the lexer rather than only at the lookup.
 * Declared **without** the `g` flag, and each call site builds its own global copy: a shared global
 * regex carries mutable `lastIndex` state, which would make repeated renders order-dependent.
 * Keeping the flag off the shared object means there is no version of it that can hold that state.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/;

/** Render one allow-listed value: `null` becomes empty, numbers stringify, strings pass through. */
function formatTemplateValue(value: string | number | null): string {
  return value === null ? '' : String(value);
}

/**
 * Interpolate a template string against an event view.
 *
 * Every `{{path}}` in the allow-list is replaced with its value; every other placeholder — an
 * unknown path, a typo, an attempt at something clever — is replaced with the empty string rather
 * than being echoed. Echoing it back would put attacker-influenced text into the delivered body
 * verbatim, and would also leave a broken template looking half-working.
 */
export function renderWebhookTemplate(template: string, view: WebhookEventView): string {
  return template.replace(new RegExp(PLACEHOLDER_PATTERN.source, 'g'), (_match, path: string) => {
    const accessor = Object.hasOwn(WEBHOOK_TEMPLATE_PATHS, path) ? WEBHOOK_TEMPLATE_PATHS[path] : undefined;
    return accessor === undefined ? '' : formatTemplateValue(accessor(view));
  });
}

/**
 * Every placeholder path in a template that is **not** in the allow-list, de-duplicated in
 * encounter order.
 *
 * For the `W7` editor: a template that silently renders empty is exactly the failure mode a user
 * cannot debug from the receiving end, so the editor names the offending paths while they are still
 * editing. Deliberately not consulted by the deliverer — a live delivery must not fail over a typo.
 *
 * `Object.hasOwn` rather than a bare lookup: a plain index would resolve inherited
 * `Object.prototype` keys, so `{{constructor}}` would appear to be a valid path.
 */
export function unknownTemplatePaths(template: string): readonly string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, 'g'))) {
    const path = match[1]!;
    if (!Object.hasOwn(WEBHOOK_TEMPLATE_PATHS, path)) unknown.add(path);
  }
  return [...unknown];
}

/**
 * The flat projection the `generic` preset sends, and the shape a `GET` flattens (see
 * {@link webhookQueryParams}).
 *
 * Every allow-listed path, one level deep with dotted keys — the same information the interpolator
 * can reach, in the same names, so "what can a template see?" has exactly one answer whichever
 * shape the user picks. Null-valued keys are kept here (JSON distinguishes them meaningfully);
 * the query flattener drops them, since a query string cannot.
 */
export function genericWebhookPayload(view: WebhookEventView): WebhookJsonObject {
  const payload: Record<string, WebhookJsonValue> = {};
  for (const path of WEBHOOK_TEMPLATE_PATH_NAMES) {
    payload[path] = WEBHOOK_TEMPLATE_PATHS[path]!(view);
  }
  return payload;
}

/**
 * A one-line human summary of the event, used by the chat presets.
 *
 * Built from the label the ledger already shaped (`describeHistoryEntry`, upstream of the view) so
 * a Discord message reads the same as the app's own activity feed rather than inventing a second
 * phrasing of the same change. Falls back to the dotted type for an event with no change — a
 * `lookup.resolved` has no label, and "lookup.resolved" is more use than a blank message.
 */
function summariseEvent(view: WebhookEventView): string {
  const label = view.change?.label ?? view.type;
  // Falsy rather than nullish on both parts: an item with a blank name, or an empty delta badge,
  // would otherwise render a dangling "Quantity changed: " or a stray "()".
  const item = view.item?.name;
  const delta = view.change?.delta;
  const head = item ? `${label}: ${item}` : label;
  return delta ? `${head} (${delta})` : head;
}

/** The preset projections. Each is a pure function of the view — no defaults, no config, no I/O. */
const PRESET_BUILDERS: Readonly<Record<WebhookPreset, (view: WebhookEventView) => WebhookJsonObject>> =
  Object.freeze({
    // Discord's incoming-webhook contract: `content` is the message body.
    discord: (view) => ({ content: summariseEvent(view) }),
    // Slack's incoming-webhook contract: `text` is the message body.
    slack: (view) => ({ text: summariseEvent(view) }),
    // Home Assistant's `webhook` trigger exposes the JSON body as `trigger.json`; snake_case keys
    // match the convention every HA template and automation is already written against.
    homeAssistant: (view) => ({
      event_type: view.type,
      occurred_at: view.occurredAt,
      item_id: view.item?.id ?? null,
      item_name: view.item?.name ?? null,
      quantity: view.item?.quantity ?? null,
      location_id: view.item?.locationId ?? null,
      location_name: view.item?.locationName ?? null,
      action: view.change?.action ?? null,
      quantity_delta: view.change?.quantityDelta ?? null,
    }),
    generic: genericWebhookPayload,
  });

/**
 * Resolve a subscription's stored `template` column into the payload to send.
 *
 * The column is a single nullable TEXT, so a preset is encoded as `preset:<name>` rather than
 * needing a second column — `W1` shipped the schema, and one string with a documented prefix is a
 * smaller thing to carry than a migration. A `preset:` string naming a preset this build does not
 * know falls back to the **default envelope** rather than to nothing: an unrecognised preset almost
 * certainly means a newer peer, and sending the standard envelope is far better than sending an
 * empty body to a live endpoint.
 */
export function resolveWebhookPayload(
  template: string | null | undefined,
  view: WebhookEventView,
): WebhookPayload {
  const trimmed = template?.trim();
  if (!trimmed) return WEBHOOK_PAYLOAD_ENVELOPE;

  if (trimmed.startsWith(WEBHOOK_PRESET_PREFIX)) {
    const name = trimmed.slice(WEBHOOK_PRESET_PREFIX.length).trim();
    if (!isWebhookPreset(name)) return WEBHOOK_PAYLOAD_ENVELOPE;
    return { kind: 'json', body: PRESET_BUILDERS[name](view) };
  }

  return { kind: 'text', body: renderWebhookTemplate(trimmed, view) };
}

/**
 * Flatten a resolved payload into `GET` query parameters — name/value pairs, in a stable order, for
 * the caller to append to the URL (`W5` owns the `URL`; this stays pure).
 *
 * Each payload kind flattens the way it can:
 *
 *   - **`envelope`** → the {@link genericWebhookPayload} projection. The real envelope is nested
 *     (`data.item.quantity`), and a nested object has no faithful query-string form; the flat
 *     projection carries the same facts in the names the template allow-list already uses.
 *   - **`json`** → its own keys. Nested values are JSON-encoded rather than dropped, so a preset
 *     that grows a nested key later degrades legibly instead of silently losing data.
 *   - **`text`** → a single `payload` parameter. A free-text template has no keys to flatten.
 *
 * `null` is **omitted**, not sent as the string `"null"`: a query string cannot express null, and
 * `?item.categoryId=null` would read to the receiver as the literal id "null".
 */
export function webhookQueryParams(
  payload: WebhookPayload,
  view: WebhookEventView,
): readonly (readonly [string, string])[] {
  if (payload.kind === 'text') return [['payload', payload.body]];
  const body = payload.kind === 'envelope' ? genericWebhookPayload(view) : payload.body;

  const params: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    params.push([key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  }
  return params;
}
