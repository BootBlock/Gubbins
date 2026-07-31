import { describe, expect, it } from 'vitest';
import { CATEGORY_PRESETS } from './category-presets';
import {
  effectiveProminenceMode,
  FIELD_PROMINENCE_MODES,
  insertTabAfter,
  MAX_FIELD_TAB_LABEL_LENGTH,
  moveTabAfter,
  normaliseFieldTabLabel,
  resolveFieldTabLabel,
  toFieldProminenceMode,
} from './field-prominence';

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((t) => t.id);

describe('toFieldProminenceMode', () => {
  it('keeps every mode this build renders', () => {
    for (const mode of FIELD_PROMINENCE_MODES) {
      expect(toFieldProminenceMode(mode)).toBe(mode);
    }
  });

  it('reads null, undefined and blank as the default', () => {
    expect(toFieldProminenceMode(null)).toBe('default');
    expect(toFieldProminenceMode(undefined)).toBe('default');
    expect(toFieldProminenceMode('')).toBe('default');
  });

  it('reads a mode this build does not recognise as the default, rather than throwing', () => {
    // A peer on a newer version may store a fourth mode. Storage keeps it verbatim; this
    // boundary simply falls back to the one position that changes nothing.
    expect(toFieldProminenceMode('floating-panel')).toBe('default');
  });

  it('does not fold case or whitespace, so storage has exactly one spelling of each mode', () => {
    expect(toFieldProminenceMode('Own-Tab')).toBe('default');
    expect(toFieldProminenceMode(' own-tab ')).toBe('default');
  });
});

describe('normaliseFieldTabLabel', () => {
  it('reads null, undefined, empty and whitespace as no label', () => {
    expect(normaliseFieldTabLabel(null)).toBeNull();
    expect(normaliseFieldTabLabel(undefined)).toBeNull();
    expect(normaliseFieldTabLabel('')).toBeNull();
    expect(normaliseFieldTabLabel('   ')).toBeNull();
  });

  it('trims the label', () => {
    expect(normaliseFieldTabLabel('  Film details  ')).toBe('Film details');
  });

  it('caps the length so a long label cannot deform the tab rail', () => {
    const long = 'A'.repeat(MAX_FIELD_TAB_LABEL_LENGTH + 10);
    expect(normaliseFieldTabLabel(long)).toHaveLength(MAX_FIELD_TAB_LABEL_LENGTH);
  });

  it('re-trims after capping, so a cut mid-space cannot leave a trailing blank', () => {
    const cutAtSpace = `${'A'.repeat(MAX_FIELD_TAB_LABEL_LENGTH - 1)} B`;
    expect(normaliseFieldTabLabel(cutAtSpace)).toBe('A'.repeat(MAX_FIELD_TAB_LABEL_LENGTH - 1));
  });

  it('is idempotent, so a saved label round-trips to itself', () => {
    const once = normaliseFieldTabLabel('  Provenance  ');
    expect(normaliseFieldTabLabel(once)).toBe(once);
  });
});

describe('resolveFieldTabLabel', () => {
  it('prefers the category’s own label', () => {
    expect(resolveFieldTabLabel('Pressing', 'Custom fields')).toBe('Pressing');
  });

  it('falls back when the category has none, or only whitespace', () => {
    expect(resolveFieldTabLabel(null, 'Custom fields')).toBe('Custom fields');
    expect(resolveFieldTabLabel('   ', 'Custom fields')).toBe('Custom fields');
  });
});

describe('effectiveProminenceMode', () => {
  it('passes every mode through while the custom fields are shown', () => {
    for (const mode of FIELD_PROMINENCE_MODES) {
      expect(effectiveProminenceMode(mode, true)).toBe(mode);
    }
  });

  it('falls back to the default when the custom fields are not shown at all', () => {
    // Invariant 2: position must never outrank a hiding decision. Promoting Classification
    // would raise a tab holding only tags and capabilities; breaking out would make an empty tab.
    for (const mode of FIELD_PROMINENCE_MODES) {
      expect(effectiveProminenceMode(mode, false)).toBe('default');
    }
  });
});

describe('moveTabAfter', () => {
  it('moves a tab to sit directly after the anchor', () => {
    const moved = moveTabAfter(
      tabs('details', 'supplier', 'media', 'classification'),
      'classification',
      'details',
    );
    expect(ids(moved)).toEqual(['details', 'classification', 'supplier', 'media']);
  });

  it('preserves the relative order of everything it does not move', () => {
    const moved = moveTabAfter(tabs('a', 'b', 'c', 'd', 'e'), 'e', 'b');
    expect(ids(moved)).toEqual(['a', 'b', 'e', 'c', 'd']);
  });

  it('is a no-op when the tab is already there', () => {
    const start = tabs('details', 'classification', 'supplier');
    expect(ids(moveTabAfter(start, 'classification', 'details'))).toEqual(ids(start));
  });

  it('leaves the order alone when either id is absent', () => {
    // A tab dropped by a feature gate must not reorder something else by accident.
    const start = tabs('details', 'supplier');
    expect(moveTabAfter(start, 'classification', 'details')).toBe(start);
    expect(moveTabAfter(start, 'supplier', 'details-that-went-away')).toBe(start);
  });

  it('refuses to move a tab after itself', () => {
    const start = tabs('a', 'b');
    expect(moveTabAfter(start, 'a', 'a')).toBe(start);
  });

  it('does not mutate the input', () => {
    const start = tabs('details', 'supplier', 'classification');
    moveTabAfter(start, 'classification', 'details');
    expect(ids(start)).toEqual(['details', 'supplier', 'classification']);
  });
});

describe('insertTabAfter', () => {
  it('inserts directly after the anchor', () => {
    const next = insertTabAfter(tabs('details', 'supplier'), { id: 'custom-fields' }, 'details');
    expect(ids(next)).toEqual(['details', 'custom-fields', 'supplier']);
  });

  it('inserts first when the anchor is absent, never last', () => {
    // The anchor is the Details tab, and the whole point of the mode is "near the front"; losing
    // the anchor should not exile the tab to the far end of the rail.
    const next = insertTabAfter(tabs('supplier', 'media'), { id: 'custom-fields' }, 'details');
    expect(ids(next)).toEqual(['custom-fields', 'supplier', 'media']);
  });

  it('does not mutate the input', () => {
    const start = tabs('details', 'supplier');
    insertTabAfter(start, { id: 'custom-fields' }, 'details');
    expect(ids(start)).toEqual(['details', 'supplier']);
  });
});

/**
 * The preset library seeds `fieldProminence` as a plain string — `CreateCategoryInput` types it
 * `string | null` so the db layer stays free of this module (the bridge imports it). That buys
 * nothing at compile time, so a typo in a preset would be silently read back as `default` and the
 * tab would simply never move. These are the guards that catch it instead.
 */
describe('CATEGORY_PRESETS custom-field prominence', () => {
  it('only names modes this build renders', () => {
    for (const preset of CATEGORY_PRESETS) {
      const mode = preset.seed.category.fieldProminence;
      if (mode == null) continue;
      expect(FIELD_PROMINENCE_MODES, `preset "${preset.id}" seeds unknown mode "${mode}"`).toContain(mode);
    }
  });

  it('omits the key entirely rather than seeding the default explicitly', () => {
    // `null` and `'default'` mean the same thing; keeping one spelling means an LWW merge can't
    // see two encodings of "leave them where they are" as a change.
    for (const preset of CATEGORY_PRESETS) {
      expect(preset.seed.category.fieldProminence, preset.id).not.toBe('default');
    }
  });

  it('only labels a tab it actually asks for', () => {
    for (const preset of CATEGORY_PRESETS) {
      if (preset.seed.category.fieldTabLabel == null) continue;
      expect(
        preset.seed.category.fieldProminence,
        `preset "${preset.id}" labels a tab it never breaks out`,
      ).toBe('own-tab');
    }
  });

  it('seeds labels that survive storage unchanged', () => {
    for (const preset of CATEGORY_PRESETS) {
      const label = preset.seed.category.fieldTabLabel;
      if (label == null) continue;
      expect(normaliseFieldTabLabel(label), `preset "${preset.id}" label is trimmed or capped on save`).toBe(
        label,
      );
    }
  });

  it('never promotes fields in a category that also hides them', () => {
    // The two settings would contradict each other, and the category manager would greet a fresh
    // import with a conflict banner it never asked for.
    for (const preset of CATEGORY_PRESETS) {
      if (toFieldProminenceMode(preset.seed.category.fieldProminence) === 'default') continue;
      expect(preset.seed.category.hiddenCapabilities ?? [], preset.id).not.toContain('custom-fields');
    }
  });

  it('gives every preset that breaks out a tab something to put in it', () => {
    for (const preset of CATEGORY_PRESETS) {
      if (preset.seed.category.fieldProminence !== 'own-tab') continue;
      expect(preset.seed.fields.length, `preset "${preset.id}" breaks out an empty tab`).toBeGreaterThan(0);
    }
  });
});
