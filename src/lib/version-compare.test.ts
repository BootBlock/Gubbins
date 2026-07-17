import { describe, it, expect } from 'vitest';
import { compareVersions } from './version-compare';

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.1.1', '0.1.2')).toBe(-1);
  });

  it('treats equal versions as 0', () => {
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats a missing component as 0 (0.2 === 0.2.0)', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('0.2', '0.2.1')).toBe(-1);
  });

  it('ignores a pre-release/build suffix', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
    expect(compareVersions('0.3.0-rc.2', '0.2.9')).toBe(1);
  });

  it('is antisymmetric', () => {
    expect(compareVersions('0.3.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.3.0')).toBe(-1);
  });
});
