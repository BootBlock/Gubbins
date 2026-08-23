/**
 * Reading a scale off Home Assistant (issue #122) — the PWA half of the inbound path.
 *
 * "Count by weight" (issue #101) already turns a gross weight into a quantity; this module only
 * supplies that weight from a **Home Assistant scale entity** instead of the user's fingers.
 * Everything downstream — the tare, the count, the confidence band, applying the delta — is
 * reused unchanged, and **manual entry remains the default**: this is an extra way to fill one
 * field, never a prerequisite.
 *
 * The reading is fetched from the **bridge**, not from Home Assistant directly, because the PWA
 * ships to an HTTPS origin and a browser there cannot fetch a plain-`http` Home Assistant on the
 * LAN (mixed content). The bridge already holds the connection details the user configured for
 * "push to bridge", so no new credential is stored in the browser — in particular the Home
 * Assistant long-lived token lives in the bridge's `.env` and never reaches this code.
 *
 * Pure and **transport-only**, in the same shape as `features/sync/push-to-bridge`: it builds a
 * request and maps a response to a friendly result, taking `fetch` as an argument. Every branch
 * returns a result rather than throwing, so the dialog has one place to render a failure, and no
 * message ever carries the bridge token.
 */
import { resolveBridgeUrl } from '@/lib/bridge-url';
import { withTimeout } from '@/lib/fetch-timeout';

/** The bridge's opt-in scale endpoints, appended to the user's configured base URL. */
export const SCALE_ENTITIES_PATH = '/api/v1/scale/entities';
export const SCALE_STATE_PATH = '/api/v1/scale/state';

/** A weight sensor the user may pick as "the scale". Mirrors the bridge's `ScaleEntityDto`. */
export interface ScaleEntity {
  readonly entityId: string;
  readonly name: string;
  readonly unit: string;
}

/** A minimal `fetch` shape so tests can inject a fake without the DOM lib types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Where the bridge is and how to authenticate — both already-configured device preferences. */
export interface BridgeConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike;
}

/**
 * Why a scale call failed, as a **machine-readable reason rather than a sentence**.
 *
 * The bridge is a Node server with no notion of the user's language, so its own error prose can't
 * be translated. What it does supply is a stable error *code*, which is exactly what a code is
 * for: this module maps status + code onto one of these reasons, and the React layer turns the
 * reason into a translated string via `t()`. That keeps every user-facing message inside the i18n
 * seam while still saying something specific.
 */
export type ScaleFailure =
  /** The bridge rejected our token. */
  | 'unauthorised'
  /** This bridge has no Home Assistant read capability (a 404 on the scale paths). */
  | 'not-enabled'
  /** The bridge itself was unreachable (offline, wrong URL, CORS). */
  | 'bridge-unreachable'
  /** The bridge is rate-limiting us. */
  | 'rate-limited'
  /** The bridge could not reach, or was refused by, Home Assistant. */
  | 'home-assistant-unreachable'
  /** The scale is off, asleep, or its integration has dropped out. */
  | 'scale-unavailable'
  /** The sensor reports a unit that cannot be converted to a weight. */
  | 'unsupported-unit'
  /** That entity does not report a numeric weight — it probably isn't a scale. */
  | 'not-a-number'
  /** No scale has been chosen yet. */
  | 'no-entity'
  /** The bridge answered, but not with anything we could read. */
  | 'bad-response';

/** A successful or failed entity listing, ready to render. */
export type ScaleEntitiesResult =
  | { readonly ok: true; readonly entities: readonly ScaleEntity[] }
  | { readonly ok: false; readonly failure: ScaleFailure };

/**
 * A successful or failed reading. On success the weight is in **canonical grams** (the bridge
 * did the unit reconciliation), alongside the raw value for an "as read: 1.25 kg" hint.
 */
export type ScaleReadingResult =
  | { readonly ok: true; readonly grams: number; readonly value: number; readonly unit: string }
  | { readonly ok: false; readonly failure: ScaleFailure };

/**
 * Build the GET a scale call makes. Throws on a blank URL/token, validated before any network.
 *
 * @internal Exported for unit tests only.
 */
export function buildScaleRequest(
  baseUrl: string,
  token: string,
  path: string,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  const url = resolveBridgeUrl(baseUrl, path);
  const trimmedToken = token.trim();
  if (trimmedToken === '') throw new Error('Enter the bridge access token.');
  return { url, headers: { authorization: `Bearer ${trimmedToken}` } };
}

/** Perform a GET against the bridge, returning the status and parsed body, or a transport failure. */
async function getJson(
  connection: BridgeConnection,
  path: string,
): Promise<{ ok: true; status: number; payload: unknown } | { ok: false; failure: ScaleFailure }> {
  let request: ReturnType<typeof buildScaleRequest>;
  try {
    request = buildScaleRequest(connection.baseUrl, connection.token, path);
  } catch {
    // A blank/malformed URL or token is indistinguishable, from here, from a bridge we can't
    // reach — and the fix is the same screen either way.
    return { ok: false, failure: 'bridge-unreachable' };
  }

  try {
    const response = await connection.fetchImpl(
      request.url,
      withTimeout({ method: 'GET', headers: { ...request.headers } }, 'bridge'),
    );
    return { ok: true, status: response.status, payload: await response.json().catch(() => undefined) };
  } catch {
    // Network error, CORS, or the bridge is offline — never expose the raw error or the token.
    return { ok: false, failure: 'bridge-unreachable' };
  }
}

/** List the weight sensors the bridge can see, for the picker. */
export async function fetchScaleEntities(connection: BridgeConnection): Promise<ScaleEntitiesResult> {
  const response = await getJson(connection, SCALE_ENTITIES_PATH);
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, failure: mapScaleFailure(response.status, response.payload) };
  }
  return { ok: true, entities: readEntities(response.payload) };
}

/** Read the current weight from one scale entity, in canonical grams. */
export async function fetchScaleReading(
  connection: BridgeConnection,
  entityId: string,
): Promise<ScaleReadingResult> {
  const trimmed = entityId.trim();
  if (trimmed === '') return { ok: false, failure: 'no-entity' };

  const response = await getJson(connection, `${SCALE_STATE_PATH}?entity_id=${encodeURIComponent(trimmed)}`);
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, failure: mapScaleFailure(response.status, response.payload) };
  }

  const grams = readNumber(response.payload, 'grams');
  const value = readNumber(response.payload, 'value');
  const unit = readString(response.payload, 'unit');
  if (grams === null || value === null || unit === null) {
    return { ok: false, failure: 'bad-response' };
  }
  return { ok: true, grams, value, unit };
}

/**
 * Map a non-2xx bridge response to a {@link ScaleFailure}.
 *
 * The bridge's **error code** is the signal, not its message: the code is a stable part of the
 * API contract, whereas the prose is untranslatable English. A `409` is therefore resolved by
 * code (`scale_unavailable` → `scale-unavailable`, …), falling back to the generic
 * `scale-unavailable` reason only when the bridge sends a `409` we don't recognise.
 *
 * @internal Exported for unit tests only.
 */
export function mapScaleFailure(status: number, payload: unknown): ScaleFailure {
  const code = readErrorCode(payload);
  switch (status) {
    case 401:
      return 'unauthorised';
    case 404:
      return 'not-enabled';
    case 409:
      if (code === 'scale_unsupported_unit') return 'unsupported-unit';
      if (code === 'scale_not_a_number') return 'not-a-number';
      return 'scale-unavailable';
    case 429:
      return 'rate-limited';
    default:
      // 502 and anything else unexpected: from the user's seat this is "the far end didn't
      // answer properly", which is the same action either way — check Home Assistant.
      return 'home-assistant-unreachable';
  }
}

/** Read the bridge's structured `{ error: { code } }` discriminator, if present. */
function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** Read the bridge's `{ entities: [...] }` payload, skipping anything malformed. */
function readEntities(payload: unknown): ScaleEntity[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { entities?: unknown }).entities;
  if (!Array.isArray(raw)) return [];

  const entities: ScaleEntity[] = [];
  for (const entry of raw) {
    const entityId = readString(entry, 'entityId');
    if (entityId === null) continue;
    entities.push({
      entityId,
      name: readString(entry, 'name') ?? entityId,
      unit: readString(entry, 'unit') ?? '',
    });
  }
  return entities;
}

function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
