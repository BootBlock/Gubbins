import { describe, it, expect } from 'vitest';
import {
  clampBytes,
  generateBridgeToken,
  DEFAULT_TOKEN_BYTES,
  MIN_TOKEN_BYTES,
  MAX_TOKEN_BYTES,
  type RandomSource,
} from './token';

/** A deterministic RandomSource that fills the buffer with a repeating byte pattern. */
function fakeRandom(pattern: number[]): RandomSource {
  return {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < view.length; i++) view[i] = pattern[i % pattern.length]!;
      return array;
    },
  };
}

describe('generateBridgeToken', () => {
  it('produces a lowercase hex string twice the byte length', () => {
    const token = generateBridgeToken(DEFAULT_TOKEN_BYTES, fakeRandom([0xab]));
    expect(token).toHaveLength(DEFAULT_TOKEN_BYTES * 2);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token).toBe('ab'.repeat(DEFAULT_TOKEN_BYTES));
  });

  it('zero-pads single-digit bytes', () => {
    const token = generateBridgeToken(MIN_TOKEN_BYTES, fakeRandom([0x00, 0x0f]));
    expect(token.startsWith('000f000f')).toBe(true);
  });

  it('clamps a too-small request up to the minimum entropy', () => {
    const token = generateBridgeToken(1, fakeRandom([0x01]));
    expect(token).toHaveLength(MIN_TOKEN_BYTES * 2);
  });

  it('clamps a too-large request down to the maximum entropy', () => {
    const token = generateBridgeToken(9999, fakeRandom([0x02]));
    expect(token).toHaveLength(MAX_TOKEN_BYTES * 2);
  });

  it('defaults to the real crypto source and yields high-entropy, non-repeating tokens', () => {
    const a = generateBridgeToken();
    const b = generateBridgeToken();
    expect(a).toHaveLength(DEFAULT_TOKEN_BYTES * 2);
    expect(a).not.toBe(b); // astronomically unlikely to collide
  });
});

describe('clampBytes', () => {
  it('keeps in-range values, rounds fractions, and defaults non-finite input', () => {
    expect(clampBytes(32)).toBe(32);
    expect(clampBytes(31.6)).toBe(32);
    expect(clampBytes(8)).toBe(MIN_TOKEN_BYTES);
    expect(clampBytes(1000)).toBe(MAX_TOKEN_BYTES);
    expect(clampBytes(Number.NaN)).toBe(DEFAULT_TOKEN_BYTES);
  });
});
