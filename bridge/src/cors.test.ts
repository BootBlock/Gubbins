/**
 * CORS origin-policy tests (issue #182) — pure functions, no server or socket. Uses only
 * placeholder origins (`example.com` / loopback), never a real host.
 */
import { describe, expect, it } from 'vitest';
import {
  corsAllowOrigin,
  DEFAULT_ALLOWED_ORIGINS,
  HOSTED_APP_ORIGIN,
  isLoopbackOrigin,
  parseAllowedOrigins,
  WILDCARD_ORIGINS,
} from './cors.ts';

describe('parseAllowedOrigins', () => {
  it('defaults to the hosted app origin when unset or blank', () => {
    const expected = { wildcard: false, origins: new Set(DEFAULT_ALLOWED_ORIGINS) };
    expect(parseAllowedOrigins(undefined)).toEqual(expected);
    expect(parseAllowedOrigins('   ')).toEqual(expected);
    expect(DEFAULT_ALLOWED_ORIGINS).toContain(HOSTED_APP_ORIGIN);
  });

  it('parses a comma-separated list, trimming and normalising to origins', () => {
    expect(parseAllowedOrigins('https://app.example.com , https://other.example.com/some/path')).toEqual({
      wildcard: false,
      origins: new Set(['https://app.example.com', 'https://other.example.com']),
    });
  });

  it('treats "*" (alone or among others) as the permissive wildcard', () => {
    expect(parseAllowedOrigins('*')).toEqual(WILDCARD_ORIGINS);
    expect(parseAllowedOrigins('https://app.example.com, *')).toEqual(WILDCARD_ORIGINS);
  });

  it('throws on a malformed or non-http(s) origin so a typo fails loudly', () => {
    expect(() => parseAllowedOrigins('not-a-url')).toThrow(/GUBBINS_BRIDGE_ALLOWED_ORIGINS/);
    expect(() => parseAllowedOrigins('ftp://app.example.com')).toThrow(/invalid origin/);
    expect(() => parseAllowedOrigins(',')).toThrow(/at least one origin/);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts http(s) localhost / 127.0.0.1 / ::1 on any port', () => {
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('https://localhost:4173')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:8080')).toBe(true);
  });

  it('rejects non-loopback hosts and non-http schemes', () => {
    expect(isLoopbackOrigin('https://app.example.com')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.example.com')).toBe(false);
    expect(isLoopbackOrigin('file://localhost')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
  });
});

describe('corsAllowOrigin', () => {
  const listed = parseAllowedOrigins('https://app.example.com');

  it('wildcard mode grants "*" to every request', () => {
    expect(corsAllowOrigin('https://evil.example', WILDCARD_ORIGINS)).toBe('*');
    expect(corsAllowOrigin(undefined, WILDCARD_ORIGINS)).toBe('*');
  });

  it('reflects an allow-listed origin and always allows loopback', () => {
    expect(corsAllowOrigin('https://app.example.com', listed)).toBe('https://app.example.com');
    expect(corsAllowOrigin('http://localhost:5173', listed)).toBe('http://localhost:5173');
  });

  it('refuses an unlisted origin and needs no header for a non-browser (no Origin) client', () => {
    expect(corsAllowOrigin('https://evil.example', listed)).toBeNull();
    expect(corsAllowOrigin(undefined, listed)).toBeNull();
  });
});
