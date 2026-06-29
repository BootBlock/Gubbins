import { describe, it, expect } from 'vitest';
import {
  buildGoogleAuthUrl,
  parseGoogleAuthFragment,
  isGoogleAuthFragment,
  tokenValid,
  type GoogleToken,
} from './google-oauth';
import { GOOGLE_AUTH_ENDPOINT, GOOGLE_DRIVE_SCOPE } from './google-config';

const config = {
  clientId: 'client-123.apps.googleusercontent.com',
  redirectUri: 'https://example.test/Gubbins/',
  scope: GOOGLE_DRIVE_SCOPE,
};

describe('buildGoogleAuthUrl', () => {
  it('targets the Google auth endpoint with the implicit (token) response type', () => {
    const url = new URL(buildGoogleAuthUrl(config, 'state-abc'));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('token');
    expect(p.get('client_id')).toBe(config.clientId);
    expect(p.get('redirect_uri')).toBe(config.redirectUri);
    expect(p.get('scope')).toBe(GOOGLE_DRIVE_SCOPE);
    expect(p.get('state')).toBe('state-abc');
    // Least-privilege incremental auth + no offline/refresh token requested (implicit flow).
    expect(p.get('include_granted_scopes')).toBe('true');
  });
});

describe('isGoogleAuthFragment', () => {
  it('recognises a token fragment and an error fragment', () => {
    expect(isGoogleAuthFragment('access_token=ya29.x&state=s')).toBe(true);
    expect(isGoogleAuthFragment('#error=access_denied&state=s')).toBe(true);
  });
  it('ignores ordinary hash-router routes', () => {
    expect(isGoogleAuthFragment('#/inventory')).toBe(false);
    expect(isGoogleAuthFragment('')).toBe(false);
    expect(isGoogleAuthFragment('#/sync?q=access_token')).toBe(false);
  });
});

describe('parseGoogleAuthFragment', () => {
  const now = 1_000_000;

  it('returns null for a non-OAuth fragment', () => {
    expect(parseGoogleAuthFragment('#/inventory', now)).toBeNull();
  });

  it('parses a successful token grant and computes the absolute expiry', () => {
    const result = parseGoogleAuthFragment(
      '#access_token=ya29.TOKEN&token_type=Bearer&expires_in=3600&scope=drive.appdata&state=state-abc',
      now,
    );
    expect(result).toEqual({
      ok: true,
      state: 'state-abc',
      token: {
        accessToken: 'ya29.TOKEN',
        expiresAt: now + 3600 * 1000,
        scope: 'drive.appdata',
      },
    });
  });

  it('treats a missing/garbled expires_in conservatively (already expired)', () => {
    const result = parseGoogleAuthFragment('#access_token=ya29.TOKEN&state=s', now);
    expect(result).toMatchObject({ ok: true });
    if (result?.ok) expect(result.token.expiresAt).toBeLessThanOrEqual(now);
  });

  it('surfaces an OAuth error with its state', () => {
    const result = parseGoogleAuthFragment('#error=access_denied&state=state-abc', now);
    expect(result).toEqual({ ok: false, error: 'access_denied', state: 'state-abc' });
  });

  it('reports a present-but-empty access_token as an error', () => {
    const result = parseGoogleAuthFragment('#access_token=&token_type=Bearer&state=s', now);
    expect(result).toEqual({ ok: false, error: 'invalid_response', state: 's' });
  });
});

describe('tokenValid', () => {
  const base: GoogleToken = { accessToken: 'ya29.x', expiresAt: 10_000_000 };

  it('is valid well before expiry', () => {
    expect(tokenValid(base, 0)).toBe(true);
  });
  it('is invalid once inside the safety skew of expiry', () => {
    // default skew 60s: a token expiring in 30s is treated as already gone.
    expect(tokenValid({ ...base, expiresAt: 30_000 }, 0, 60_000)).toBe(false);
  });
  it('rejects an empty token', () => {
    expect(tokenValid({ accessToken: '', expiresAt: 10_000 }, 0)).toBe(false);
  });
});
