/**
 * Target-sourcing tests (webhooks plan `W5`, §3.1 / §6.1) over a hydrated SYNTHETIC snapshot.
 *
 * Two behaviours matter most here and are pinned hardest:
 *
 *   - **`secret_ref` never silently degrades to unsigned.** A subscription whose named secret the
 *     bridge cannot resolve is *dropped*, with a warning naming the ref. Delivering it unsigned
 *     would be the worst outcome: the user asked for a signed webhook and their receiver is
 *     verifying signatures.
 *   - **A subscription cannot set a credential or a reserved header.** Those are filtered out and
 *     reported, rather than quietly forwarded.
 */
import { describe, expect, it } from 'vitest';
import { hydrateFromJson } from '../hydrate.ts';
import {
  configTargetToDeliveryTarget,
  isAllowedWebhookHeader,
  loadDatabaseWebhookTargets,
  parseWebhookSecrets,
  sanitiseWebhookHeaders,
} from './webhook-targets.ts';

interface WebhookRowInput {
  id: string;
  name: string;
  url?: string;
  method?: string;
  enabled?: number;
  secret?: string | null;
  secret_ref?: string | null;
  event_types?: string;
  filter?: string | null;
  template?: string | null;
  headers?: string | null;
}

/** A minimal synthetic snapshot carrying only the `webhooks` rows under test. */
function snapshot(webhooks: readonly WebhookRowInput[]): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedAt: 1_751_000_000_000,
    tables: {
      locations: [],
      categories: [],
      items: [],
      item_stock: [],
      item_history: [],
      webhooks: webhooks.map((row) => ({
        url: 'https://hooks.example.test/inventory',
        method: 'POST',
        enabled: 1,
        secret: null,
        secret_ref: null,
        event_types: JSON.stringify(['*']),
        filter: null,
        template: null,
        headers: null,
        created_at: 1_750_000_000_000,
        updated_at: 1_751_000_000_000,
        ...row,
      })),
    },
  });
}

async function load(webhooks: readonly WebhookRowInput[], secrets: Record<string, string> = {}) {
  const { driver } = await hydrateFromJson(snapshot(webhooks));
  return loadDatabaseWebhookTargets(driver, secrets);
}

describe('parseWebhookSecrets', () => {
  it('accepts an absent value as an empty map — a bridge with no named secrets is normal', () => {
    expect(parseWebhookSecrets(undefined)).toEqual({});
    expect(parseWebhookSecrets(null)).toEqual({});
  });

  it('accepts a flat name → secret object', () => {
    expect(parseWebhookSecrets({ discord: 'placeholder-value' })).toEqual({ discord: 'placeholder-value' });
  });

  it('rejects a non-object, a blank name and a non-string or empty value', () => {
    expect(() => parseWebhookSecrets([])).toThrow(/object/i);
    expect(() => parseWebhookSecrets({ '  ': 'x' })).toThrow(/blank/i);
    expect(() => parseWebhookSecrets({ a: 42 })).toThrow(/non-empty/i);
    expect(() => parseWebhookSecrets({ a: '' })).toThrow(/non-empty/i);
  });

  it('never puts a secret value in its error message', () => {
    try {
      parseWebhookSecrets({ discord: 42 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('discord');
      expect((err as Error).message).not.toContain('42');
    }
  });
});

describe('isAllowedWebhookHeader / sanitiseWebhookHeaders', () => {
  it('refuses credential headers, computed headers and the reserved x-gubbins- family', () => {
    for (const name of [
      'authorization',
      'Authorization',
      'cookie',
      'proxy-authorization',
      'host',
      'content-length',
      'content-type',
      'X-Gubbins-Signature',
      'x-gubbins-anything',
      '   ',
    ]) {
      expect(isAllowedWebhookHeader(name)).toBe(false);
    }
  });

  it('allows an ordinary custom header', () => {
    expect(isAllowedWebhookHeader('X-Custom-Token-Name')).toBe(true);
    expect(isAllowedWebhookHeader('Accept')).toBe(true);
  });

  it('keeps the legitimate headers and reports the dropped ones', () => {
    const { headers, dropped } = sanitiseWebhookHeaders({
      Authorization: 'Bearer x',
      'X-Custom': 'keep me',
    });
    expect(headers).toEqual({ 'X-Custom': 'keep me' });
    expect(dropped).toEqual(['Authorization']);
  });

  it('collapses to null when nothing survives', () => {
    expect(sanitiseWebhookHeaders({ cookie: 'a=b' }).headers).toBeNull();
    expect(sanitiseWebhookHeaders(null).headers).toBeNull();
  });
});

describe('configTargetToDeliveryTarget', () => {
  it('adapts a legacy config target to the richer model with unsurprising defaults', () => {
    const target = configTargetToDeliveryTarget({ url: 'https://a.example.test/h', secret: 's' }, 0);
    expect(target).toMatchObject({
      id: 'config:0',
      source: 'config',
      method: 'POST',
      enabled: true,
      filter: null,
      template: null,
      headers: null,
      // An absent `events` list keeps EI-1's "no filter means everything" rule.
      eventTypes: ['*'],
    });
  });

  it('carries an explicit events list through unchanged', () => {
    const target = configTargetToDeliveryTarget(
      { url: 'https://a.example.test/h', secret: 's', events: ['item.created'] },
      1,
    );
    expect(target.eventTypes).toEqual(['item.created']);
    expect(target.id).toBe('config:1');
  });
});

describe('loadDatabaseWebhookTargets', () => {
  it('reads a subscription into the delivery model', async () => {
    const { targets, warnings } = await load([
      {
        id: 'w1',
        name: 'Workshop notifier',
        method: 'GET',
        event_types: JSON.stringify(['item.low_stock']),
        template: 'preset:discord',
      },
    ]);
    expect(warnings).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: 'w1',
      name: 'Workshop notifier',
      source: 'database',
      method: 'GET',
      enabled: true,
      secret: null,
      eventTypes: ['item.low_stock'],
      template: 'preset:discord',
    });
  });

  it('uses an in-row secret as-is', async () => {
    const { targets } = await load([{ id: 'w1', name: 'A', secret: 'in-row-placeholder' }]);
    expect(targets[0]!.secret).toBe('in-row-placeholder');
  });

  it('resolves a secret_ref against the bridge-side secrets', async () => {
    const { targets, warnings } = await load([{ id: 'w1', name: 'A', secret_ref: 'discord' }], {
      discord: 'resolved-placeholder',
    });
    expect(warnings).toEqual([]);
    expect(targets[0]!.secret).toBe('resolved-placeholder');
  });

  it('DROPS a subscription whose secret_ref cannot be resolved — never delivers it unsigned', async () => {
    const { targets, warnings } = await load([
      { id: 'w1', name: 'Workshop notifier', secret_ref: 'missing' },
    ]);
    expect(targets).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing');
    expect(warnings[0]).toContain('Workshop notifier');
  });

  it('reports the dropped subscription in a shape a delivery-log row can use (issue #643)', async () => {
    // Without this the refusal reaches the operator's stdout and nowhere else, and the app's log
    // reads "Nothing delivered yet" for a webhook that has stopped entirely.
    const { blocked } = await load([
      { id: 'w1', name: 'Workshop notifier', method: 'PUT', secret_ref: 'missing' },
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      id: 'w1',
      name: 'Workshop notifier',
      url: 'https://hooks.example.test/inventory',
      method: 'PUT',
    });
    expect(blocked[0]!.reason).toContain('missing');
  });

  it('leaves a disabled subscription out of the blocked list — it is off, not broken', async () => {
    // The operator still gets the warning; the app does not get an hourly "Blocked" row about a
    // webhook the user switched off on purpose.
    const { warnings, blocked } = await load([
      { id: 'w1', name: 'Workshop notifier', enabled: 0, secret_ref: 'missing' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(blocked).toEqual([]);
  });

  it('reports nothing as blocked when every subscription resolves', async () => {
    const { blocked } = await load([{ id: 'w1', name: 'A', secret_ref: 'discord' }], {
      discord: 'resolved-placeholder',
    });
    expect(blocked).toEqual([]);
  });

  it('keeps a subscription that signs with neither — an unsigned webhook is legal', async () => {
    const { targets, warnings } = await load([{ id: 'w1', name: 'A' }]);
    expect(warnings).toEqual([]);
    expect(targets[0]!.secret).toBeNull();
  });

  it('loads a disabled subscription rather than filtering it, leaving the matcher to decide', async () => {
    // One place decides what "disabled" means (the W3 matcher), so the two cannot drift.
    const { targets } = await load([{ id: 'w1', name: 'A', enabled: 0 }]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.enabled).toBe(false);
  });

  it('strips a forbidden header and says so', async () => {
    const { targets, warnings } = await load([
      { id: 'w1', name: 'A', headers: JSON.stringify({ Authorization: 'Bearer x', 'X-Ok': 'y' }) },
    ]);
    expect(targets[0]!.headers).toEqual({ 'X-Ok': 'y' });
    expect(warnings[0]).toContain('Authorization');
  });

  it('never puts a secret value in a warning', async () => {
    const { warnings } = await load([{ id: 'w1', name: 'A', secret_ref: 'missing' }], {
      other: 'a-secret-value',
    });
    expect(warnings.join(' ')).not.toContain('a-secret-value');
  });

  it('reads across pages', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: `w${i}`, name: `Hook ${i}` }));
    const { targets } = await load(rows);
    expect(targets).toHaveLength(150);
  });
});
