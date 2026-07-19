import { describe, it, expect } from 'vitest';
import { strToU8 } from 'fflate';
import { CHECKSUM_ALGORITHM, checksumBytes } from './checksum';

describe('checksumBytes', () => {
  it('matches the standard CRC-32 of a known input', () => {
    // The canonical check value for CRC-32/ISO-HDLC — pins the polynomial and bit order, so a
    // future rewrite cannot silently change what every existing backup was stamped with.
    expect(checksumBytes(strToU8('123456789'))).toBe('cbf43926');
    expect(checksumBytes(new Uint8Array())).toBe('00000000');
  });

  it('always returns eight hex digits, including for a leading-zero digest', () => {
    // A digest formatted as a bare number would compare unequal to the same value zero-padded.
    for (const text of ['a', 'ab', 'abc', 'gubbins', 'x'.repeat(1000)]) {
      expect(checksumBytes(strToU8(text))).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('changes when any byte changes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const baseline = checksumBytes(bytes);
    for (let i = 0; i < bytes.length; i += 1) {
      const damaged = new Uint8Array(bytes);
      damaged[i]! ^= 0xff;
      expect(checksumBytes(damaged)).not.toBe(baseline);
    }
    // Truncation — the failure this exists to catch — must not hash the same either.
    expect(checksumBytes(bytes.slice(0, 4))).not.toBe(baseline);
  });

  it('names the algorithm it implements', () => {
    expect(CHECKSUM_ALGORITHM).toBe('crc32');
  });
});
