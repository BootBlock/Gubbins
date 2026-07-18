import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEBHOOK_METHOD,
  WEBHOOK_ALL_EVENTS,
  isWebhookMethod,
  normaliseWebhookEventTypes,
  normaliseWebhookHeaders,
  normaliseWebhookMethod,
  normaliseWebhookName,
  normaliseWebhookText,
  planWebhookSubscription,
  sanitiseWebhookUrl,
} from './subscription';

/**
 * The pure webhook-subscription seam (issue #87) — the validation/normalisation choke-point
 * every create goes through, tested in isolation from any SQL or network.
 */
describe('normaliseWebhookMethod', () => {
  it('accepts every supported method, case- and whitespace-insensitively', () => {
    expect(normaliseWebhookMethod('post')).toBe('POST');
    expect(normaliseWebhookMethod('  Get ')).toBe('GET');
    expect(normaliseWebhookMethod('PUT')).toBe('PUT');
    expect(normaliseWebhookMethod('patch')).toBe('PATCH');
  });

  /**
   * A method is guarded by a DB CHECK, so an unknown one could never be written anyway —
   * softening keeps a stale peer row readable instead of failing the whole read.
   */
  it('softens an unknown or absent method to the default', () => {
    expect(normaliseWebhookMethod('DELETE')).toBe(DEFAULT_WEBHOOK_METHOD);
    expect(normaliseWebhookMethod('')).toBe(DEFAULT_WEBHOOK_METHOD);
    expect(normaliseWebhookMethod(null)).toBe(DEFAULT_WEBHOOK_METHOD);
    expect(normaliseWebhookMethod(undefined)).toBe(DEFAULT_WEBHOOK_METHOD);
  });

  it('guards the method union', () => {
    expect(isWebhookMethod('POST')).toBe(true);
    expect(isWebhookMethod('post')).toBe(false); // the guard is exact; normalise first
    expect(isWebhookMethod('DELETE')).toBe(false);
    expect(isWebhookMethod(42)).toBe(false);
  });
});

describe('sanitiseWebhookUrl', () => {
  it('accepts absolute http and https endpoints', () => {
    expect(sanitiseWebhookUrl('https://example.test/hook')).toBe('https://example.test/hook');
    expect(sanitiseWebhookUrl('  http://192.0.2.10:8123/api/webhook/x  ')).toBe(
      'http://192.0.2.10:8123/api/webhook/x',
    );
  });

  /**
   * Deliberately stricter than the wishlist's link sanitiser: guessing `https://` for a LAN box
   * the user meant to reach over plain `http` yields a subscription that silently never fires.
   */
  it('rejects a scheme-less endpoint rather than guessing https', () => {
    expect(sanitiseWebhookUrl('example.test/hook')).toBeUndefined();
    expect(sanitiseWebhookUrl('localhost:8123/hook')).toBeUndefined();
  });

  it('rejects a blank endpoint — a subscription with no address is not a subscription', () => {
    expect(sanitiseWebhookUrl('')).toBeUndefined();
    expect(sanitiseWebhookUrl('   ')).toBeUndefined();
    expect(sanitiseWebhookUrl(null)).toBeUndefined();
  });

  it('rejects non-web schemes', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x', 'ftp://x.test']) {
      expect(sanitiseWebhookUrl(url)).toBeUndefined();
    }
  });
});

describe('normaliseWebhookEventTypes', () => {
  it('trims, drops blanks and de-duplicates while preserving order', () => {
    expect(normaliseWebhookEventTypes([' item.created ', 'item.moved', '', 'item.created'])).toEqual([
      'item.created',
      'item.moved',
    ]);
  });

  it('collapses a list containing the wildcard to just the wildcard', () => {
    expect(normaliseWebhookEventTypes(['item.created', WEBHOOK_ALL_EVENTS])).toEqual([WEBHOOK_ALL_EVENTS]);
  });

  /** A subscription matching nothing would be silently inert — an error, not an empty list. */
  it('returns undefined when nothing usable survives', () => {
    expect(normaliseWebhookEventTypes([])).toBeUndefined();
    expect(normaliseWebhookEventTypes(['  ', ''])).toBeUndefined();
    expect(normaliseWebhookEventTypes(null)).toBeUndefined();
  });
});

describe('normaliseWebhookHeaders', () => {
  it('trims header names and passes values through', () => {
    expect(normaliseWebhookHeaders({ '  X-Source ': 'gubbins' })).toEqual({ 'X-Source': 'gubbins' });
  });

  it('treats an absent or empty map as no headers', () => {
    expect(normaliseWebhookHeaders(null)).toBeNull();
    expect(normaliseWebhookHeaders(undefined)).toBeNull();
    expect(normaliseWebhookHeaders({})).toBeNull();
  });

  it('rejects a blank name or a non-text value', () => {
    expect(normaliseWebhookHeaders({ '   ': 'x' })).toBeUndefined();
    expect(normaliseWebhookHeaders({ 'X-Count': 3 as unknown as string })).toBeUndefined();
  });
});

describe('normaliseWebhookName / normaliseWebhookText', () => {
  it('trims to a canonical form, or null when blank', () => {
    expect(normaliseWebhookName('  Discord  ')).toBe('Discord');
    expect(normaliseWebhookName('   ')).toBeNull();
    expect(normaliseWebhookName(undefined)).toBeNull();
    expect(normaliseWebhookText('  {{event.type}} ')).toBe('{{event.type}}');
    expect(normaliseWebhookText('')).toBeNull();
  });
});

describe('planWebhookSubscription', () => {
  const draft = { name: 'Discord', url: 'https://example.test/hook', eventTypes: ['item.created'] };

  it('normalises a valid draft into a ready-to-persist subscription', () => {
    const plan = planWebhookSubscription({ ...draft, name: ' Discord ', method: 'put' });
    expect(plan).toEqual({
      ok: true,
      subscription: {
        name: 'Discord',
        url: 'https://example.test/hook',
        method: 'PUT',
        enabled: true,
        secret: null,
        secretRef: null,
        eventTypes: ['item.created'],
        filter: null,
        template: null,
        headers: null,
      },
    });
  });

  it('defaults a subscription to enabled, and honours an explicit false', () => {
    expect(planWebhookSubscription(draft)).toMatchObject({ subscription: { enabled: true } });
    expect(planWebhookSubscription({ ...draft, enabled: false })).toMatchObject({
      subscription: { enabled: false },
    });
  });

  it.each([
    ['EMPTY_NAME', { ...draft, name: '  ' }],
    ['INVALID_URL', { ...draft, url: 'not-a-url' }],
    ['NO_EVENT_TYPES', { ...draft, eventTypes: [] }],
    ['SECRET_CONFLICT', { ...draft, secret: 'value', secretRef: 'name' }],
    ['INVALID_HEADERS', { ...draft, headers: { '': 'x' } }],
  ])('rejects a draft with reason %s', (reason, bad) => {
    expect(planWebhookSubscription(bad)).toEqual({ ok: false, reason });
  });

  /**
   * Either secret form alone is fine, and so is neither — an unsigned webhook to a trusted
   * endpoint on your own LAN is a reasonable thing to want. Only *both* is ambiguous.
   */
  it('accepts either secret form alone, or neither', () => {
    expect(planWebhookSubscription({ ...draft, secret: ' value ' })).toMatchObject({
      subscription: { secret: 'value', secretRef: null },
    });
    expect(planWebhookSubscription({ ...draft, secretRef: ' name ' })).toMatchObject({
      subscription: { secret: null, secretRef: 'name' },
    });
    expect(planWebhookSubscription(draft)).toMatchObject({
      subscription: { secret: null, secretRef: null },
    });
  });

  /** A blank string in either secret field is "not set", so the pair does not read as a conflict. */
  it('does not treat a blank secret beside a secret_ref as a conflict', () => {
    expect(planWebhookSubscription({ ...draft, secret: '   ', secretRef: 'name' })).toMatchObject({
      ok: true,
      subscription: { secret: null, secretRef: 'name' },
    });
  });
});
