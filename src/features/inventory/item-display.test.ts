import { describe, expect, it } from 'vitest';
import { itemDisplayName } from './item-display';

describe('itemDisplayName', () => {
  it('leaves a non-serialised item as its bare name', () => {
    expect(itemDisplayName('Torque wrench', null)).toBe('Torque wrench');
  });

  it('appends the instance number for a serialised clone', () => {
    expect(itemDisplayName('Torque wrench', 3)).toBe('Torque wrench #3');
  });

  it('appends #0 — a zeroth instance is still an instance, not "no serial"', () => {
    expect(itemDisplayName('Torque wrench', 0)).toBe('Torque wrench #0');
  });

  it('treats undefined like null rather than rendering "#undefined"', () => {
    expect(itemDisplayName('Torque wrench', undefined)).toBe('Torque wrench');
  });
});
