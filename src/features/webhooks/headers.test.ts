import { describe, expect, it } from 'vitest';
import {
  isAllowedWebhookHeader,
  sanitiseWebhookHeaders,
  webhookHeaderIssue,
  WEBHOOK_FORBIDDEN_HEADERS,
} from './headers';

describe('isAllowedWebhookHeader', () => {
  it.each(WEBHOOK_FORBIDDEN_HEADERS)('refuses %s', (name) => {
    expect(isAllowedWebhookHeader(name)).toBe(false);
  });

  it('refuses a forbidden name regardless of case or padding', () => {
    expect(isAllowedWebhookHeader('  AUTHORIZATION ')).toBe(false);
    expect(isAllowedWebhookHeader('Cookie')).toBe(false);
  });

  // Letting a subscription set these would let it forge the signature the deliverer computes.
  it('refuses the reserved Gubbins prefix', () => {
    expect(isAllowedWebhookHeader('X-Gubbins-Signature')).toBe(false);
    expect(isAllowedWebhookHeader('x-gubbins-anything')).toBe(false);
  });

  it('refuses an empty or whitespace name', () => {
    expect(isAllowedWebhookHeader('')).toBe(false);
    expect(isAllowedWebhookHeader('   ')).toBe(false);
  });

  it('allows an ordinary custom header', () => {
    expect(isAllowedWebhookHeader('X-Custom-Token-Name')).toBe(true);
    expect(isAllowedWebhookHeader('Accept')).toBe(true);
  });
});

describe('sanitiseWebhookHeaders', () => {
  it('keeps the legitimate headers and reports what was dropped', () => {
    const { headers, dropped } = sanitiseWebhookHeaders({
      Authorization: 'Bearer x',
      'X-Source': 'gubbins',
    });
    expect(headers).toEqual({ 'X-Source': 'gubbins' });
    expect(dropped).toEqual(['Authorization']);
  });

  it('returns null when nothing survives, and for no headers at all', () => {
    expect(sanitiseWebhookHeaders({ cookie: 'a=b' }).headers).toBeNull();
    expect(sanitiseWebhookHeaders(null).headers).toBeNull();
  });
});

describe('webhookHeaderIssue', () => {
  // The editor says *which* rule a name breaks; "reserved" and "forbidden" are different mistakes
  // and lead the user to different fixes.
  it('distinguishes the reasons a name is refused', () => {
    expect(webhookHeaderIssue('')).toBe('empty');
    expect(webhookHeaderIssue('   ')).toBe('empty');
    expect(webhookHeaderIssue('X-Gubbins-Signature')).toBe('reserved');
    expect(webhookHeaderIssue('Authorization')).toBe('forbidden');
    expect(webhookHeaderIssue('content-type')).toBe('forbidden');
  });

  it('returns null for an allowed name', () => {
    expect(webhookHeaderIssue('X-Source')).toBeNull();
  });

  it('agrees with isAllowedWebhookHeader in both directions', () => {
    for (const name of ['X-Source', 'Authorization', 'X-Gubbins-Delivery', '', 'Accept']) {
      expect(webhookHeaderIssue(name) === null).toBe(isAllowedWebhookHeader(name));
    }
  });
});
