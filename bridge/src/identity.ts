/**
 * Who is calling, and what may they do (issue #79, plan §1.3).
 *
 * The bridge used to authenticate with a single shared `GUBBINS_BRIDGE_TOKEN`: anyone holding
 * it got everything the env flags allowed, and every write was attributed to the System user
 * because there was nobody else it *could* be attributed to. That is replaced here. A token is
 * now minted per user in the app; this module resolves a presented one to the user who owns
 * it, resolves that user's {@link Authority} through the app's **own** permission engine, and
 * hands back an identity the router gates on and the write path attributes to.
 *
 * Three things are worth understanding before changing anything:
 *
 * - **Authentication needs the snapshot.** The bridge owns no database; `api_tokens` reaches it
 *   in the synced snapshot, exactly as `webhooks` targets do. So until the first snapshot has
 *   loaded there is nothing to resolve a token against, and every request — including the
 *   otherwise state-independent scale reads — answers `503` rather than being let through. That
 *   is a deliberate change of posture from "works before the snapshot loads": failing closed is
 *   the only safe direction when the question is *who is this*.
 *
 * - **The env capability flags stay an outer bound.** {@link requiredPermissions} answers what a
 *   caller must hold; it never answers whether a route exists. A route disabled by
 *   `GUBBINS_BRIDGE_ALLOW_WRITES` (or push, events, HA…) is still a `404` for everyone, however
 *   permissive their role. Permissions can only ever narrow what the operator already enabled.
 *
 * - **A request is identified once, when it arrives.** That is the right granularity for every
 *   route bar one: `GET /api/v1/events` holds a single response open indefinitely, so a stream
 *   authorised before a revocation keeps delivering until the client disconnects. Revocation is
 *   immediate for every new request and for the reconnect an `EventSource` makes on its own, but
 *   it does not reach into a live stream. Closing streams on re-hydration would fix it and would
 *   also drop every consumer on each ordinary sync, which is a worse trade for a read-only feed
 *   of inventory changes; the limitation is documented rather than papered over.
 *
 * - **The permission engine is imported, not reimplemented.** `resolveAuthority` / `can` come
 *   straight from `src/features/users`, so a role means the same thing here as it does in the
 *   app. That is also why the engine is kept free of React, I/O and `src/db` — and why nothing
 *   in this file may use `enum`, `namespace` or parameter properties, which Node's strip-only
 *   loader rejects.
 */
import { ApiTokenRepository } from '@/db/repositories/ApiTokenRepository';
import { RoleRepository } from '@/db/repositories/RoleRepository';
import { UserRepository } from '@/db/repositories/UserRepository';
import { can, resolveAuthority, type Authority } from '@/features/users/permissions';
import type { PermissionKey } from '@/features/users/permission-registry';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { API_V1_BASE } from './api/v1.ts';

/** A caller the bridge has successfully identified. */
export interface BridgeIdentity {
  /** The owning user's id. Every write the request performs is attributed to it. */
  readonly userId: string;
  /** What that user may do, resolved through the app's permission engine. */
  readonly authority: Authority;
}

/**
 * Resolve a presented token to an identity, or `null` when it matches no live token.
 *
 * A revoked token is simply a row that no longer exists (revocation is a hard, tombstoned
 * delete — see `ApiTokenRepository`), so there is no "is it revoked?" check here that a future
 * caller could forget. Likewise a deleted user takes their tokens with them via
 * `ON DELETE CASCADE`, and a token whose user somehow does not exist resolves to `null` rather
 * than to anything permissive.
 *
 * The authority is resolved with `moduleEnabled: true` **unconditionally**, which deserves its
 * own sentence: whether sign-in is switched on is a per-device UI choice the bridge cannot see
 * and should not inherit. A token was minted deliberately, for one named user, so it carries
 * that user's permissions always. In single-user mode — where the app acts as Admin — a token
 * minted against Admin resolves to `unrestricted`, so nothing about the shipped default changes.
 */
export async function resolveIdentity(
  driver: IDatabaseDriver,
  token: string,
): Promise<BridgeIdentity | null> {
  const userId = await new ApiTokenRepository(driver).resolveUserId(token);
  if (userId === undefined) return null;

  const user = await new UserRepository(driver).getById(userId);
  if (user === undefined) return null;

  const grants =
    user.roleId === null ? undefined : (await new RoleRepository(driver).getById(user.roleId))?.permissions;

  return {
    userId: user.id,
    authority: resolveAuthority({
      moduleEnabled: true,
      user: { id: user.id, kind: user.kind, isEnabled: user.isEnabled },
      grants,
    }),
  };
}

/**
 * The permission keys a request must hold, **all** of them, to be answered.
 *
 * Every route requires `bridge:read` or `bridge:write` — the capability of using the bridge at
 * all, so an operator can withhold remote access from a role without having to withhold each
 * underlying subject — plus the subject the route actually exposes. A role that may read items
 * in the app can read them here; one that may not, cannot, and no longer gets to sidestep that
 * by holding the one shared token.
 *
 * An unrecognised path falls back to `bridge:read`. It will 404 in the router regardless, and
 * defaulting to the *narrowest* requirement means a path added later without a mapping is not
 * silently exempt from the `bridge:*` gate.
 */
export function requiredPermissions(method: string, pathname: string): readonly PermissionKey[] {
  if (method === 'POST') return postPermissions(pathname);

  // Legacy (unversioned) paths — the shipped Home Assistant contract.
  switch (pathname) {
    case '/health':
      return ['bridge:read'];
    case '/search':
    case '/where':
    case '/metrics':
      return ['bridge:read', 'items:read'];
  }

  const segments = v1Segments(pathname);
  if (segments === null) return ['bridge:read'];

  switch (segments[0]) {
    // The index, the OpenAPI document, `$metadata`, `/health` and the event stream describe the
    // bridge itself rather than any inventory, so using the bridge is the whole requirement.
    case undefined:
    case 'openapi.json':
    case '$metadata':
    case 'health':
    case 'events':
    case 'scale':
      return ['bridge:read'];
    // `status` sits with the item reads because its counts are aggregates over `items` — how
    // many match each attention status, never which, so no loan, order or schedule detail is
    // disclosed by it.
    case 'status':
    case 'search':
    case 'where':
    case 'items':
    case 'items.csv':
    case 'capabilities':
      return ['bridge:read', 'items:read'];
    case 'locations':
      return ['bridge:read', 'locations:read'];
    case 'categories':
      return ['bridge:read', 'categories:read'];
    // The OData service is the same three reads under a different envelope, so it must carry the
    // same permissions — reaching `items` through `/odata/items` cannot be the cheaper door. The
    // set is named one segment deeper, so the decision is delegated rather than flattened here.
    case 'odata':
      return ['bridge:read', ...odataSetPermissions(segments[1])];
    // The calendar feed publishes asset bookings, so it is gated on bookings rather than items.
    case 'calendar.ics':
      return ['bridge:read', 'bookings:read'];
    // The syndication feeds publish the Activity Ledger — the audit trail. `audit:view` is the
    // permission the plan introduces precisely so "only specific users can view history" is
    // expressible, and a feed URL is the easiest way to read that history from outside the app.
    case 'activity.rss':
    case 'activity.atom':
    case 'activity.json':
      return ['bridge:read', 'audit:view'];
    // The webhook delivery log reports what the operator's own subscriptions did — configuration
    // rather than inventory.
    case 'webhooks':
      return ['bridge:read', 'settings:read'];
    default:
      return ['bridge:read'];
  }
}

/**
 * The entity-set permission an OData resource needs, on top of `bridge:read`.
 *
 * The segment addresses a set with an optional key (`items`, `items('abc')`, `items/$count`), so
 * the set name is whatever precedes the parenthesis. The service document (no segment) and
 * `$metadata` describe the service rather than any inventory, so they need nothing further — and
 * neither does a segment naming no set at all, which the router answers as a `404`.
 */
function odataSetPermissions(segment: string | undefined): readonly PermissionKey[] {
  switch (segment?.split('(')[0]) {
    case 'items':
      return ['items:read'];
    case 'locations':
      return ['locations:read'];
    case 'categories':
      return ['categories:read'];
    default:
      return [];
  }
}

/** The permissions required by the (few) POST routes. */
function postPermissions(pathname: string): readonly PermissionKey[] {
  const segments = v1Segments(pathname);
  if (segments === null) return ['bridge:write'];

  switch (segments[0]) {
    // Replacing the served snapshot wholesale is a sync operation, not a stock edit.
    case 'snapshot':
      return ['bridge:write', 'sync:write'];
    // A test fire mutates no inventory, but it does make the bridge issue an outbound request on
    // the operator's behalf using their configured subscriptions — a settings-level action.
    case 'webhooks':
      return ['bridge:write', 'settings:write'];
    // The only inventory writes: the stock adjust endpoints. `stock:write` and not `items:write`
    // is the phase-2 distinction — changing how much there is of something is not editing the
    // item record, and the Stocker role exists to draw exactly that line.
    case 'items':
      return ['bridge:write', 'stock:write'];
    default:
      return ['bridge:write'];
  }
}

/**
 * The path segments below `/api/v1`, or `null` when the path is not a versioned one. An empty
 * array means the base itself (the discovery index).
 */
function v1Segments(pathname: string): readonly string[] | null {
  if (pathname !== API_V1_BASE && !pathname.startsWith(`${API_V1_BASE}/`)) return null;
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .slice(2);
}

/** Whether `identity` holds every permission `method` + `pathname` requires. */
export function isPermitted(identity: BridgeIdentity, method: string, pathname: string): boolean {
  return requiredPermissions(method, pathname).every((key) => can(identity.authority, key));
}
