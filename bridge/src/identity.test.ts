/**
 * Identity resolution and per-route enforcement (issue #79, plan §1.3).
 *
 * Two layers, both over the SYNTHETIC fixture (no real or personal data):
 *
 *   1. The pure route→permission map, asserted directly — including the rule that *every* route
 *      requires a `bridge:*` capability, which is what lets an operator withhold remote access
 *      from a role without unpicking each subject.
 *   2. The real HTTP server, driven in-process with tokens minted for users of differing roles.
 *      A permission map that is right in isolation but not consulted by the server would pass
 *      layer 1 and fail here, which is the failure worth catching.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleRepository } from '@/db/repositories/RoleRepository';
import { UserRepository } from '@/db/repositories/UserRepository';
import { ADMIN_USER_ID, SYSTEM_USER_ID } from '@/db/repositories/constants';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { createBridgeServer, type BridgeServerState } from './server.ts';
import { mintTestToken } from './fixtures/test-identity.ts';
import { isPermitted, requiredPermissions, resolveIdentity } from './identity.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

let hydrated: HydrateResult;
let state: BridgeServerState;
let server: ReturnType<typeof createBridgeServer>;
let baseUrl: string;

/** Tokens for principals of differing authority, all minted against the fixture. */
let adminToken = '';
let viewerToken = '';
let rolelessToken = '';
let disabledToken = '';

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };

  const users = new UserRepository(hydrated.driver);
  const roles = new RoleRepository(hydrated.driver);

  // A read-only role that can use the bridge and read items, but nothing more — the shape an
  // operator would actually give a dashboard.
  const viewer = await roles.create({
    name: 'Bridge reader',
    permissions: ['bridge:read', 'items:read'],
  });
  const viewerUser = await users.create({
    username: 'reader',
    displayName: 'Ravi Sharma',
    roleId: viewer.id,
  });
  const roleless = await users.create({ username: 'noone', displayName: 'Nils Berg' });
  const disabled = await users.create({
    username: 'ex-staff',
    displayName: 'Dana Vogel',
    roleId: viewer.id,
  });
  await users.update(disabled.id, { isEnabled: false });

  adminToken = await mintTestToken(hydrated.driver);
  viewerToken = await mintTestToken(hydrated.driver, viewerUser.id);
  rolelessToken = await mintTestToken(hydrated.driver, roleless.id);
  disabledToken = await mintTestToken(hydrated.driver, disabled.id);

  server = createBridgeServer({ getState: () => state });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hydrated.driver.close();
});

function get(path: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

// --- the pure map -----------------------------------------------------------------

describe('requiredPermissions', () => {
  it('gates every route on a bridge capability, so remote access can be withheld wholesale', () => {
    const paths = [
      '/health',
      '/search',
      '/where',
      '/metrics',
      '/api/v1',
      '/api/v1/openapi.json',
      '/api/v1/status',
      '/api/v1/items',
      '/api/v1/locations',
      '/api/v1/categories',
      '/api/v1/calendar.ics',
      '/api/v1/activity.rss',
      '/api/v1/events',
      '/api/v1/scale/entities',
      '/api/v1/webhooks/deliveries',
      '/api/v1/something-added-later',
    ];
    for (const path of paths) {
      expect(requiredPermissions('GET', path)).toContain('bridge:read');
    }
    for (const path of ['/api/v1/items/x/adjust-quantity', '/api/v1/snapshot', '/api/v1/webhooks/test']) {
      expect(requiredPermissions('POST', path)).toContain('bridge:write');
    }
  });

  it('maps a route to the subject it actually exposes', () => {
    expect(requiredPermissions('GET', '/api/v1/items')).toEqual(['bridge:read', 'items:read']);
    // The attention counts are aggregates over items, so they need the same subject items do.
    expect(requiredPermissions('GET', '/api/v1/status')).toEqual(['bridge:read', 'items:read']);
    expect(requiredPermissions('GET', '/api/v1/locations')).toEqual(['bridge:read', 'locations:read']);
    expect(requiredPermissions('GET', '/api/v1/categories')).toEqual(['bridge:read', 'categories:read']);
    // The calendar publishes bookings and the feeds publish the audit trail — neither is "items".
    expect(requiredPermissions('GET', '/api/v1/calendar.ics')).toEqual(['bridge:read', 'bookings:read']);
    expect(requiredPermissions('GET', '/api/v1/activity.json')).toEqual(['bridge:read', 'audit:view']);
    // Adjusting quantity is `stock:write`, not `items:write` — the line the Stocker role draws.
    expect(requiredPermissions('POST', '/api/v1/items/abc/adjust-quantity')).toEqual([
      'bridge:write',
      'stock:write',
    ]);
    expect(requiredPermissions('POST', '/api/v1/snapshot')).toEqual(['bridge:write', 'sync:write']);
  });

  it('gates the OData service on the same permissions as its REST twin (issue #361)', () => {
    // The envelope changed, not the data — so `/odata/items` cannot be the cheaper door to items.
    expect(requiredPermissions('GET', '/api/v1/odata/items')).toEqual(['bridge:read', 'items:read']);
    expect(requiredPermissions('GET', "/api/v1/odata/items('abc')")).toEqual(['bridge:read', 'items:read']);
    expect(requiredPermissions('GET', '/api/v1/odata/items/$count')).toEqual(['bridge:read', 'items:read']);
    expect(requiredPermissions('GET', '/api/v1/odata/locations')).toEqual(['bridge:read', 'locations:read']);
    expect(requiredPermissions('GET', '/api/v1/odata/categories')).toEqual([
      'bridge:read',
      'categories:read',
    ]);
    // The service document and the CSDL describe the service, not any inventory.
    expect(requiredPermissions('GET', '/api/v1/odata')).toEqual(['bridge:read']);
    expect(requiredPermissions('GET', '/api/v1/odata/$metadata')).toEqual(['bridge:read']);
  });
});

// --- resolution -------------------------------------------------------------------

describe('resolveIdentity', () => {
  it('resolves a token to its owner and their authority', async () => {
    const identity = await resolveIdentity(hydrated.driver, adminToken);
    expect(identity?.userId).toBe(ADMIN_USER_ID);
    // Admin's permissions are implicit and not editable, so they resolve to unrestricted.
    expect(identity?.authority).toEqual({ mode: 'unrestricted' });
  });

  it('resolves an unknown token to nothing at all', async () => {
    expect(await resolveIdentity(hydrated.driver, 'gbn_not-a-real-token')).toBeNull();
    expect(await resolveIdentity(hydrated.driver, '')).toBeNull();
  });

  it('grants a role holder exactly their role, and nobody a wider one', async () => {
    const identity = await resolveIdentity(hydrated.driver, viewerToken);
    expect(isPermitted(identity!, 'GET', '/api/v1/items')).toBe(true);
    expect(isPermitted(identity!, 'GET', '/api/v1/locations')).toBe(false);
    expect(isPermitted(identity!, 'POST', '/api/v1/items/x/adjust-quantity')).toBe(false);
    // …and the OData spelling of each read lands on the same side of the line.
    expect(isPermitted(identity!, 'GET', '/api/v1/odata/items')).toBe(true);
    expect(isPermitted(identity!, 'GET', '/api/v1/odata/locations')).toBe(false);
  });

  it('denies a user with no role and a user who is disabled', async () => {
    const roleless = await resolveIdentity(hydrated.driver, rolelessToken);
    expect(roleless?.authority).toEqual({ mode: 'denied', reason: 'no-role' });

    const disabled = await resolveIdentity(hydrated.driver, disabledToken);
    expect(disabled?.authority).toEqual({ mode: 'denied', reason: 'disabled' });
  });
});

// --- enforcement over the real server ---------------------------------------------

describe('the server enforces the identity it resolved', () => {
  it('answers a permitted route for a restricted caller', async () => {
    expect((await get('/api/v1/items', viewerToken)).status).toBe(200);
  });

  it('403s a route the caller is authenticated for but not permitted', async () => {
    const res = await get('/api/v1/locations', viewerToken);
    expect(res.status).toBe(403);
    // 401 and 403 must stay distinguishable: one sends you hunting for a bad token, the other
    // for a role.
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('403s the audit feeds for a caller without audit:view', async () => {
    expect((await get('/api/v1/activity.json', viewerToken)).status).toBe(403);
    expect((await get('/api/v1/activity.json', adminToken)).status).toBe(200);
  });

  it('401s an unknown or revoked token, not 403', async () => {
    const res = await get('/api/v1/items', 'gbn_not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses a disabled user and a user with no role on every route', async () => {
    for (const token of [disabledToken, rolelessToken]) {
      expect((await get('/health', token)).status).toBe(403);
      expect((await get('/api/v1/items', token)).status).toBe(403);
    }
  });

  it('lets an unrestricted caller everywhere the operator has enabled', async () => {
    expect((await get('/health', adminToken)).status).toBe(200);
    expect((await get('/api/v1/items', adminToken)).status).toBe(200);
    expect((await get('/api/v1/locations', adminToken)).status).toBe(200);
  });

  // The env capability flags are an OUTER bound: this server was built with no write capability,
  // so a write is a 404 for the unrestricted Admin too. A permission can never re-open what the
  // operator switched off.
  it('keeps a disabled capability a 404 even for an unrestricted caller', async () => {
    const res = await fetch(`${baseUrl}/api/v1/items/item-m3-bolt/adjust-quantity`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ delta: 1 }),
    });
    expect(res.status).toBe(404);
  });

  // System is the actor the app writes as, not a person — but it is still unrestricted, so a
  // token minted against it must work rather than being a special case that silently denies.
  it('resolves a token minted for the System principal', async () => {
    const token = await mintTestToken(hydrated.driver, SYSTEM_USER_ID);
    expect((await get('/api/v1/items', token)).status).toBe(200);
  });
});
