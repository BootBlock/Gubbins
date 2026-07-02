/**
 * §9.4.2 HTTP-status classification + §9.4.3 degradation messaging (Phase 35).
 *
 * Both seams are pure, so they are exhaustively unit-tested here — the deepened
 * taxonomy (BLOCKED/NOT_FOUND/SERVER_ERROR) is proved at the producer (status→type)
 * and consumer (type→actionable text) edges without a real network or DOM.
 */
import { describe, expect, it } from 'vitest';
import { classifyHttpStatus, describeScrapeError, detectChallengePage } from './scrape-errors';
import { SCRAPE_ERROR_TYPES, type ScrapeErrorPayload, type ScrapeErrorType } from './protocol';

describe('classifyHttpStatus (§9.4.2)', () => {
  it('returns null for a usable 2xx response', () => {
    for (const ok of [200, 201, 204, 299]) {
      expect(classifyHttpStatus(ok)).toBeNull();
    }
  });

  it('maps 429 → RATE_LIMITED', () => {
    expect(classifyHttpStatus(429)?.errorType).toBe('RATE_LIMITED');
  });

  it.each([404, 410])('maps %s → NOT_FOUND', (status) => {
    expect(classifyHttpStatus(status)?.errorType).toBe('NOT_FOUND');
  });

  it.each([401, 403, 407])('maps auth/forbidden %s → BLOCKED', (status) => {
    expect(classifyHttpStatus(status)?.errorType).toBe('BLOCKED');
  });

  it.each([400, 406, 451, 499])('maps other client-error %s → BLOCKED', (status) => {
    expect(classifyHttpStatus(status)?.errorType).toBe('BLOCKED');
  });

  it.each([500, 502, 503, 504])('maps server-error %s → SERVER_ERROR', (status) => {
    expect(classifyHttpStatus(status)?.errorType).toBe('SERVER_ERROR');
  });

  it('never reports a transport timeout — that is the caller catch, not a status', () => {
    // No HTTP status maps to NETWORK_TIMEOUT (only an abort/DNS failure with no response).
    const types = [200, 301, 400, 403, 404, 429, 500, 503].map((s) => classifyHttpStatus(s)?.errorType);
    expect(types).not.toContain('NETWORK_TIMEOUT');
  });

  it('carries the offending status code in the reason string', () => {
    expect(classifyHttpStatus(503)?.reason).toContain('503');
    expect(classifyHttpStatus(404)?.reason).toContain('404');
  });

  it('classifies every non-2xx into a member of the wire enum', () => {
    for (const status of [301, 400, 401, 403, 404, 406, 410, 429, 451, 500, 503, 599]) {
      const failure = classifyHttpStatus(status);
      expect(failure).not.toBeNull();
      expect(SCRAPE_ERROR_TYPES).toContain(failure!.errorType);
    }
  });
});

describe('detectChallengePage (§9.4.2 — Phase 36)', () => {
  it('returns null for an ordinary product page (no false positive)', () => {
    const html = `<!doctype html><html><head><title>NE555P | DigiKey</title></head>
      <body><h1 itemprop="name">NE555P Precision Timer</h1>
      <span class="price">£0.42</span>
      <form action="/contact"><div class="g-recaptcha" data-sitekey="abc"></div></form>
      </body></html>`;
    // A bare reCAPTCHA widget on a contact form must NOT be treated as a challenge.
    expect(detectChallengePage(html)).toBeNull();
  });

  it.each([
    ['Cloudflare "Just a moment"', '<title>Just a moment...</title><div id="cf-challenge"></div>'],
    ['Cloudflare browser check', '<body>Checking your browser before accessing example.com</body>'],
    ['Cloudflare challenge-platform', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>'],
    ['Cloudflare attention page', '<title>Attention Required! | Cloudflare</title>'],
    ['Imperva Incapsula', '<html><body>Request unsuccessful. Incapsula incident ID: 123-456</body></html>'],
    ['PerimeterX', '<div id="px-captcha"></div>'],
    ['DataDome', '<script src="https://geo.captcha-delivery.com/captcha/"></script>'],
  ])('flags a high-confidence interstitial: %s', (_label, html) => {
    const failure = detectChallengePage(html);
    expect(failure).not.toBeNull();
    expect(failure!.errorType).toBe('CHALLENGE');
  });

  it('names the challenge in the reason and yields a wire-enum member', () => {
    const failure = detectChallengePage('<title>Just a moment...</title>');
    expect(failure!.reason).toMatch(/challenge/i);
    expect(SCRAPE_ERROR_TYPES).toContain(failure!.errorType);
  });

  it('is case-insensitive (vendors vary their markup casing)', () => {
    expect(detectChallengePage('<TITLE>JUST A MOMENT...</TITLE>')?.errorType).toBe('CHALLENGE');
  });
});

describe('describeScrapeError (§9.4.3)', () => {
  const at = (error_type: ScrapeErrorType, domain = 'digikey.co.uk'): ScrapeErrorPayload => ({
    domain,
    error_type,
    reason: 'raw diagnostic',
  });

  it('produces a distinct, manual-entry-nudging message for every known type', () => {
    const messages = SCRAPE_ERROR_TYPES.map((t) => describeScrapeError(at(t)));
    // Each names the domain.
    for (const m of messages) expect(m).toContain('digikey.co.uk');
    // Each is unique (no two types collapse to the same wording).
    expect(new Set(messages).size).toBe(SCRAPE_ERROR_TYPES.length);
  });

  it('uses the BLOCKED wording (the headline Phase-35 distinction)', () => {
    expect(describeScrapeError(at('BLOCKED'))).toContain('blocked the request');
  });

  it('points the user at the URL for NOT_FOUND and at retry for SERVER_ERROR', () => {
    expect(describeScrapeError(at('NOT_FOUND'))).toMatch(/check the URL/i);
    expect(describeScrapeError(at('SERVER_ERROR'))).toMatch(/try again later/i);
  });

  it('nudges opening the page in a tab for a CHALLENGE interstitial (Phase 36)', () => {
    const message = describeScrapeError(at('CHALLENGE'));
    expect(message).toMatch(/challenge/i);
    expect(message).toMatch(/tab/i);
  });

  it('falls back to the raw reason for an unrecognised (forward-compat) type', () => {
    const future = {
      domain: 'mouser.com',
      error_type: 'METEOR_STRIKE',
      reason: 'cosmic',
    } as unknown as ScrapeErrorPayload;
    expect(describeScrapeError(future)).toBe('mouser.com: cosmic');
  });
});
