import { describe, it, expect } from 'vitest';
import { ALL_EMOJIS } from './emoji-data';
import { filterEmojis, emojiName } from './emoji-search';

describe('filterEmojis', () => {
  it('returns the whole corpus for an empty / whitespace query', () => {
    expect(filterEmojis('')).toBe(ALL_EMOJIS);
    expect(filterEmojis('   ')).toBe(ALL_EMOJIS);
  });

  it('matches on the display name', () => {
    const chars = filterEmojis('battery').map((e) => e.char);
    expect(chars).toContain('🔋');
  });

  it('matches on keywords not present in the name', () => {
    // 🚗 is "Automobile"; "car" only lives in its keywords.
    expect(filterEmojis('car').map((e) => e.char)).toContain('🚗');
    // 🔩 is "Nut and bolt"; "screw" only lives in its keywords.
    expect(filterEmojis('screw').map((e) => e.char)).toContain('🔩');
  });

  it('requires every term (AND) regardless of order', () => {
    const a = filterEmojis('red heart').map((e) => e.char);
    const b = filterEmojis('heart red').map((e) => e.char);
    expect(a).toEqual(b);
    expect(a).toContain('❤️');
  });

  it('returns nothing for an unmatched query', () => {
    expect(filterEmojis('zzzznotanemoji')).toHaveLength(0);
  });
});

describe('emojiName', () => {
  it('resolves a catalogued emoji to its name', () => {
    expect(emojiName('🔋')).toBe('Battery');
  });

  it('returns null for an unknown or empty value', () => {
    expect(emojiName('🦄')).toBeNull();
    expect(emojiName(null)).toBeNull();
    expect(emojiName(undefined)).toBeNull();
  });
});
