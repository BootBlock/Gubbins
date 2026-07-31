import { describe, it, expect } from 'vitest';
import {
  DESCRIPTION_SNIPPET_MAX_LENGTH,
  descriptionSnippet,
  resolveLocationDetailFields,
  type LocationDetailField,
} from './location-detail';

/**
 * The pure model behind a location's own detail (issue #617, `N1`) — what the panel shows, and
 * the one-line preview a sub-location card carries. (The `N2` search haystack is assembled in
 * SQL and covered by `CategoryRepository.inheritance.test.ts`.)
 */

function field(overrides: Partial<LocationDetailField> = {}): LocationDetailField {
  return { defId: 'def-1', name: 'Load rating', fieldType: 'TEXT', unit: null, value: '30 kg', ...overrides };
}

describe('resolveLocationDetailFields', () => {
  it('shows a number field’s unit beside the value, as an item card does (W1b)', () => {
    expect(
      resolveLocationDetailFields([
        field({ fieldType: 'NUMBER', name: 'Load rating', unit: 'kg', value: '30' }),
      ]),
    ).toEqual([{ id: 'def-1', label: 'Load rating', value: { kind: 'measure', text: '30', unit: 'kg' } }]);
  });

  it('resolves a value into the same descriptor an item card renders', () => {
    expect(resolveLocationDetailFields([field()])).toEqual([
      { id: 'def-1', label: 'Load rating', value: { kind: 'text', text: '30 kg' } },
    ]);
  });

  it('drops unset and blank values rather than showing an em-dash row', () => {
    // Unlike an item card — where every configured field keeps a row so cards in a list stay the
    // same height — this panel shows one location and has nothing to line up with.
    expect(
      resolveLocationDetailFields([field({ value: null }), field({ defId: 'd2', value: '   ' })]),
    ).toEqual([]);
  });

  it('formats by field type, exactly as the item card does', () => {
    const resolved = resolveLocationDetailFields([
      field({ defId: 'b', name: 'Ventilated', fieldType: 'BOOLEAN', value: 'true' }),
      field({ defId: 'o', name: 'Heating', fieldType: 'ON_OFF', value: 'false' }),
    ]);
    expect(resolved.map((f) => f.value)).toEqual([
      { kind: 'text', text: 'Yes' },
      { kind: 'text', text: 'Off' },
    ]);
  });

  it('renders an IMAGE value as a thumbnail, not its base64 text', () => {
    const src = 'data:image/webp;base64,AAAA';
    const [resolved] = resolveLocationDetailFields([
      field({ defId: 'i', name: 'Shelf photo', fieldType: 'IMAGE', value: src }),
    ]);
    expect(resolved?.value).toEqual({ kind: 'image', src });
  });

  it('preserves the order it is given', () => {
    const resolved = resolveLocationDetailFields([
      field({ defId: 'a', name: 'Access code' }),
      field({ defId: 'z', name: 'Zone' }),
    ]);
    expect(resolved.map((f) => f.label)).toEqual(['Access code', 'Zone']);
  });
});

describe('descriptionSnippet', () => {
  it('returns null when there is nothing to preview', () => {
    expect(descriptionSnippet(null)).toBeNull();
    expect(descriptionSnippet(undefined)).toBeNull();
    expect(descriptionSnippet('')).toBeNull();
    expect(descriptionSnippet('   \n  ')).toBeNull();
  });

  it('flattens Markdown to one plain line', () => {
    expect(descriptionSnippet('## Overflow\n\nFor the **workshop**')).toBe('Overflow For the workshop');
  });

  it('reduces a link to its label', () => {
    expect(descriptionSnippet('See the [manual](https://example.com/manual.pdf)')).toBe('See the manual');
  });

  it('strips bullets and quote markers, which only mean anything at the start of a line', () => {
    expect(descriptionSnippet('- Dry\n- Unheated\n> Watch the step')).toBe('Dry Unheated Watch the step');
    expect(descriptionSnippet('1. Unlock\n2. Lift')).toBe('Unlock Lift');
  });

  it('keeps a literal marker mid-sentence rather than mangling the text', () => {
    // The flattening is lossy, so it errs toward what the user actually typed.
    expect(descriptionSnippet('Bin #3 holds M3-10 screws')).toBe('Bin #3 holds M3-10 screws');
    expect(descriptionSnippet('Keyed to part_number_ref')).toBe('Keyed to part_number_ref');
  });

  it('leaves a short description untouched', () => {
    expect(descriptionSnippet('Key is in the kitchen drawer')).toBe('Key is in the kitchen drawer');
  });

  it('truncates on a word boundary with an ellipsis', () => {
    const snippet = descriptionSnippet('alpha bravo charlie delta echo foxtrot', 20);
    expect(snippet).toBe('alpha bravo charlie…');
  });

  it('cuts mid-word only when the last word is longer than half the limit', () => {
    expect(descriptionSnippet('a supercalifragilisticexpialidocious', 20)).toBe('a supercalifragilist…');
  });

  it('never splits an astral character in half', () => {
    // Ten 2-code-unit emoji: a UTF-16 slice at 5 would leave a lone surrogate.
    const snippet = descriptionSnippet('😀'.repeat(10), 5);
    expect(snippet).toBe(`${'😀'.repeat(5)}…`);
  });

  it('defaults to the shared cap', () => {
    const long = 'x'.repeat(DESCRIPTION_SNIPPET_MAX_LENGTH + 50);
    expect(descriptionSnippet(long)).toHaveLength(DESCRIPTION_SNIPPET_MAX_LENGTH + 1);
  });
});
