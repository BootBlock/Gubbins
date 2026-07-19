/**
 * Bridge API token minting/hashing tests (issue #79, plan §1.3).
 *
 * The properties that matter are the ones a caller cannot see: that the stored form is not a
 * usable credential, that two mints never collide, and that the prefix is short enough to be a
 * label rather than a hint. No real token appears here — every value is generated in-process.
 */
import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_BYTES,
  API_TOKEN_DISPLAY_CHARS,
  API_TOKEN_PREFIX,
  apiTokenDisplayPrefix,
  generateApiToken,
  hashApiToken,
  mintApiToken,
} from './api-token';

/** A deterministic randomness source, so a generated token can be asserted exactly. */
function fakeRandom(pattern: readonly number[]) {
  return {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = pattern[i % pattern.length]!;
      return array;
    },
  };
}

describe('generateApiToken', () => {
  it('is the prefix followed by hex-encoded entropy', () => {
    const token = generateApiToken(fakeRandom([0xab]));
    expect(token).toBe(`${API_TOKEN_PREFIX}${'ab'.repeat(API_TOKEN_BYTES)}`);
  });

  it('zero-pads a low byte rather than emitting a single hex digit', () => {
    // A naive `toString(16)` would render 0x0f as "f" and quietly shorten the token.
    const token = generateApiToken(fakeRandom([0x00, 0x0f]));
    expect(token.slice(API_TOKEN_PREFIX.length)).toHaveLength(API_TOKEN_BYTES * 2);
    expect(token.startsWith(`${API_TOKEN_PREFIX}000f`)).toBe(true);
  });

  it('produces a different token every time', () => {
    expect(generateApiToken()).not.toBe(generateApiToken());
  });
});

describe('hashApiToken', () => {
  it('is a stable lowercase hex SHA-256', async () => {
    const hash = await hashApiToken('gbn_example');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiToken('gbn_example')).toBe(hash);
  });

  it('never returns the token itself — the stored form is not a usable credential', async () => {
    const token = generateApiToken();
    expect(await hashApiToken(token)).not.toContain(token.slice(API_TOKEN_PREFIX.length));
  });

  it('ignores surrounding whitespace, so a pasted token still resolves', async () => {
    expect(await hashApiToken('  gbn_example\n')).toBe(await hashApiToken('gbn_example'));
  });

  it('separates two tokens differing in one character', async () => {
    expect(await hashApiToken('gbn_aaaa')).not.toBe(await hashApiToken('gbn_aaab'));
  });
});

describe('apiTokenDisplayPrefix', () => {
  it('keeps only the leading characters', () => {
    const token = generateApiToken();
    const prefix = apiTokenDisplayPrefix(token);
    expect(prefix).toHaveLength(API_TOKEN_DISPLAY_CHARS);
    expect(token.startsWith(prefix)).toBe(true);
  });

  // The prefix is shown in the clear, so it has to stay a label rather than a meaningful
  // fraction of the secret.
  it('exposes only a few characters of entropy beyond the fixed prefix', () => {
    expect(API_TOKEN_DISPLAY_CHARS - API_TOKEN_PREFIX.length).toBeLessThanOrEqual(8);
  });
});

describe('mintApiToken', () => {
  it('returns a token whose hash and prefix match it', async () => {
    const minted = await mintApiToken();
    expect(minted.hash).toBe(await hashApiToken(minted.token));
    expect(minted.prefix).toBe(apiTokenDisplayPrefix(minted.token));
  });
});
