/**
 * §9.1/§9.2 Secure Bridge Handshake — schema validation, signature & origin checks.
 *
 * The CRITICAL security property under test: an invalid, unsigned or foreign-origin
 * message is *silently dropped* (returns null), never throwing and never trusting it.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SOURCE,
  extensionMessageSchema,
  makeMessage,
  parseExtensionMessage,
  SCRAPE_ERROR_TYPES,
  type ScrapeResultPayload,
} from './protocol';

const TRUSTED = 'https://example.test';
const ctx = { origin: TRUSTED, trustedOrigins: [TRUSTED] };

const validResult: ScrapeResultPayload = {
  mpn: 'NE555P',
  manufacturer: 'Texas Instruments',
  description: 'Precision timer IC',
  distributor_url: 'https://www.digikey.com/product/NE555P',
  scraped_pricing: { currency: 'GBP', value: 0.42 },
};

describe('parseExtensionMessage — origin verification (§9.1.1)', () => {
  it('drops a message from an untrusted origin', () => {
    const msg = makeMessage('SCRAPE_RESULT', validResult, 'req-1');
    expect(parseExtensionMessage(msg, { origin: 'https://evil.test', trustedOrigins: [TRUSTED] })).toBeNull();
  });

  it('drops everything when nothing is trusted', () => {
    const msg = makeMessage('EXTENSION_READY', { version: '1.0.0' });
    expect(parseExtensionMessage(msg, { origin: TRUSTED, trustedOrigins: [] })).toBeNull();
  });

  it('accepts a well-formed message from a trusted origin', () => {
    const msg = makeMessage('SCRAPE_RESULT', validResult, 'req-1');
    const parsed = parseExtensionMessage(msg, ctx);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('SCRAPE_RESULT');
  });
});

describe('parseExtensionMessage — signature & schema (§9.1.2, §9.2)', () => {
  it('drops a message lacking the mandatory source signature', () => {
    const msg = { type: 'SCRAPE_RESULT', payload: validResult };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('drops a message with a forged source signature', () => {
    const msg = { source: 'SOME_OTHER_EXT', type: 'SCRAPE_RESULT', payload: validResult };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('drops a message with an unknown type', () => {
    const msg = { source: EXTENSION_SOURCE, type: 'EXEC_SHELL', payload: {} };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it.each([null, undefined, 42, 'hello', [], () => {}])('drops a non-object payload (%s)', (raw) => {
    expect(parseExtensionMessage(raw, ctx)).toBeNull();
  });

  it('does not throw on hostile input', () => {
    const hostile = {
      source: EXTENSION_SOURCE,
      type: 'SCRAPE_RESULT',
      payload: { __proto__: { polluted: true } },
    };
    expect(() => parseExtensionMessage(hostile, ctx)).not.toThrow();
    expect(parseExtensionMessage(hostile, ctx)).toBeNull();
  });
});

describe('parseExtensionMessage — payload validation (§9.4.2 no NaN/garbage)', () => {
  it('rejects a result with a non-finite price', () => {
    const msg = makeMessage(
      'SCRAPE_RESULT',
      { ...validResult, scraped_pricing: { currency: 'GBP', value: Number.NaN } },
      'req-1',
    );
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('rejects a result with a non-URL distributor_url', () => {
    const msg = {
      source: EXTENSION_SOURCE,
      type: 'SCRAPE_RESULT',
      payload: { ...validResult, distributor_url: 'not-a-url' },
    };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('accepts a result with null pricing (price genuinely absent)', () => {
    const msg = makeMessage('SCRAPE_RESULT', { ...validResult, scraped_pricing: null }, 'req-1');
    const parsed = parseExtensionMessage(msg, ctx);
    expect(parsed?.type).toBe('SCRAPE_RESULT');
  });

  it('accepts a valid SCRAPE_ERROR with a known error_type', () => {
    const msg = makeMessage(
      'SCRAPE_ERROR',
      { domain: 'digikey.com', error_type: 'DOM_DRIFT', reason: 'price selector .price-now not found' },
      'req-1',
    );
    const parsed = parseExtensionMessage(msg, ctx);
    expect(parsed?.type).toBe('SCRAPE_ERROR');
  });

  it('rejects a SCRAPE_ERROR with an unknown error_type', () => {
    const msg = {
      source: EXTENSION_SOURCE,
      type: 'SCRAPE_ERROR',
      payload: { domain: 'x', error_type: 'METEOR_STRIKE', reason: 'r' },
    };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it.each(SCRAPE_ERROR_TYPES)(
    'accepts a SCRAPE_ERROR carrying the %s taxonomy member (Phase 35)',
    (error_type) => {
      const msg = makeMessage('SCRAPE_ERROR', { domain: 'mouser.com', error_type, reason: 'r' }, 'req-1');
      const parsed = parseExtensionMessage(msg, ctx);
      expect(parsed?.type).toBe('SCRAPE_ERROR');
    },
  );

  it('exposes the deepened taxonomy (the new HTTP-status members are wire-valid)', () => {
    for (const member of ['BLOCKED', 'NOT_FOUND', 'SERVER_ERROR'] as const) {
      expect(SCRAPE_ERROR_TYPES).toContain(member);
    }
  });

  it('accepts EXTENSION_READY with no payload', () => {
    const msg = { source: EXTENSION_SOURCE, type: 'EXTENSION_READY' };
    const parsed = parseExtensionMessage(msg, ctx);
    expect(parsed?.type).toBe('EXTENSION_READY');
  });
});

describe('makeMessage', () => {
  it('stamps the mandatory source signature and the requestId', () => {
    const msg = makeMessage('SCRAPE_REQUEST', { url: 'https://www.mouser.co.uk/x' }, 'req-42');
    expect(msg.source).toBe(EXTENSION_SOURCE);
    expect(msg.requestId).toBe('req-42');
    expect(extensionMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('omits requestId for EXTENSION_READY (no correlation needed)', () => {
    const msg = makeMessage('EXTENSION_READY', { version: '1.0.0' });
    expect('requestId' in msg).toBe(false);
    expect(extensionMessageSchema.safeParse(msg).success).toBe(true);
  });
});

describe('requestId correlation (§9 multi-scrape)', () => {
  it('drops a scrape message missing its requestId', () => {
    const msg = { source: EXTENSION_SOURCE, type: 'SCRAPE_RESULT', payload: validResult };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('drops a scrape message with a blank requestId', () => {
    const msg = { source: EXTENSION_SOURCE, type: 'SCRAPE_RESULT', requestId: '', payload: validResult };
    expect(parseExtensionMessage(msg, ctx)).toBeNull();
  });

  it('round-trips the requestId on a valid result', () => {
    const parsed = parseExtensionMessage(makeMessage('SCRAPE_RESULT', validResult, 'req-7'), ctx);
    expect(parsed?.type === 'SCRAPE_RESULT' && parsed.requestId).toBe('req-7');
  });
});
