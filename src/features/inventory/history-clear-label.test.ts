import { describe, it, expect } from 'vitest';
import { clearedByLabel } from './history-clear-label';

describe('clearedByLabel (issue #620)', () => {
  it('names the signed-in user when there is one', () => {
    expect(clearedByLabel('Ada Lovelace', 'e4f1c2a0-0000-4000-8000-000000000000')).toBe('Ada Lovelace');
  });

  it('falls back to a short device marker when nobody is signed in', () => {
    // Gubbins' default has no accounts and no server, so there is no user and no client IP to
    // record — the device is the only honest answer to "who did this?".
    expect(clearedByLabel(null, 'e4f1c2a0-0000-4000-8000-000000000000')).toBe('device e4f1c2a0');
  });

  it('treats a blank display name as no name, never recording an empty "cleared by"', () => {
    expect(clearedByLabel('   ', 'abcdef01-0000-4000-8000-000000000000')).toBe('device abcdef01');
    expect(clearedByLabel(undefined, 'abcdef01-0000-4000-8000-000000000000')).toBe('device abcdef01');
  });

  it('trims a padded display name rather than recording the padding', () => {
    expect(clearedByLabel('  Ada  ', 'abcdef01-0000-4000-8000-000000000000')).toBe('Ada');
  });
});
