/**
 * The two-key sequence grammar and matcher (issue #127), plus the preset and conflict-rival
 * helpers that hang off the same registry.
 *
 * Kept separate from `hotkeys.test.ts` so the original single-chord contract stays readable as
 * its own document; everything here is about what changed when a binding gained a second chord.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEY_BINDINGS,
  HOTKEY_PRESETS,
  applyHotkeyPreset,
  bindingFromEvent,
  displayBinding,
  findHotkeyConflictRivals,
  isSequenceBinding,
  normaliseHotkeyBindings,
  parseSequence,
  rejectBinding,
  stepHotkeySequence,
  type HotkeyAction,
  type HotkeyActionId,
  type HotkeyBinding,
} from './hotkeys';

/** Every action enabled — the matcher's gating is covered by the single-chord suite. */
const allEnabled = () => true;

/** A complete binding map with only the named overrides differing from the defaults. */
function bindings(overrides: Partial<Record<HotkeyActionId, HotkeyBinding>>) {
  return normaliseHotkeyBindings({ ...DEFAULT_HOTKEY_BINDINGS, ...overrides });
}

describe('parseSequence', () => {
  it('reads a single chord as a one-step sequence', () => {
    expect(parseSequence('Ctrl+/')).toEqual(['Ctrl+/']);
    expect(isSequenceBinding('Ctrl+/')).toBe(false);
  });

  it('splits a two-chord sequence', () => {
    expect(parseSequence('G R')).toEqual(['G', 'R']);
    expect(isSequenceBinding('G R')).toBe(true);
  });

  it('rejects an empty step, and anything longer than two chords', () => {
    expect(parseSequence('G  R')).toBeNull();
    expect(parseSequence('G R T')).toBeNull();
    expect(parseSequence('')).toBeNull();
  });
});

describe('rejectBinding over a sequence', () => {
  it('accepts a well-formed sequence', () => {
    expect(rejectBinding('G R')).toBeNull();
    expect(rejectBinding('G Shift+P')).toBeNull();
  });

  it('rejects a sequence containing a browser-reserved key, wherever it sits', () => {
    // The whole point: `F5` is unusable, and hiding it behind a prefix does not change that.
    expect(rejectBinding('G F5')).toBe('reserved');
    expect(rejectBinding('F5 G')).toBe('reserved');
  });

  it('rejects a malformed chord inside a sequence', () => {
    expect(rejectBinding('G Ctrl+')).toBe('malformed');
  });
});

describe('displayBinding over a sequence', () => {
  it('keeps the two chords visibly separate rather than joining them', () => {
    expect(displayBinding('G R', false)).toBe('G R');
  });

  it('still spells each chord the platform way', () => {
    expect(displayBinding('G Ctrl+R', true)).toBe('G ⌘R');
  });
});

describe('chordFromEvent — shifted punctuation', () => {
  it('does not double-count Shift for a character that already encodes it', () => {
    // `?` is what the keyboard reports for Shift+/, so storing `Shift+?` would be a chord
    // requiring Shift twice — and unreproducible on a layout where `?` is unshifted.
    expect(
      bindingFromEvent({ key: '?', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('?');
  });

  it('keeps Shift for a letter, where it is a genuine distinction', () => {
    expect(
      bindingFromEvent({ key: 'A', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('Shift+A');
  });

  it('keeps Shift for a non-ASCII letter too', () => {
    // `Ä` is a letter, not shifted punctuation. Dropping Shift here would store `Shift+Ä` as plain
    // `Ä`, so pressing the *unshifted* `ä` would later fire the shortcut — a German-layout user
    // triggering a shortcut they bound to the shifted key.
    expect(
      bindingFromEvent({ key: 'Ä', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('Shift+Ä');
  });

  it('still drops Shift for punctuation that is not a letter or digit', () => {
    for (const key of ['?', ':', '!', '<']) {
      expect(
        bindingFromEvent({ key, ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
        key,
      ).toBe(key);
    }
  });
});

describe('stepHotkeySequence', () => {
  const map = bindings({ 'nav.reports': 'G R', 'nav.inventory': 'F1' });

  it('arms on a prefix rather than firing anything', () => {
    const step = stepHotkeySequence(null, 'G', map, allEnabled);
    expect(step).toEqual({ kind: 'pending', prefix: 'G' });
  });

  it('fires the action when the second chord completes the sequence', () => {
    const step = stepHotkeySequence('G', 'R', map, allEnabled);
    expect(step.kind).toBe('fire');
    expect((step as { action: HotkeyAction }).action.id).toBe('nav.reports');
  });

  it('fires a plain single-chord binding with nothing pending', () => {
    const step = stepHotkeySequence(null, 'F1', map, allEnabled);
    expect((step as { action: HotkeyAction }).action.id).toBe('nav.inventory');
  });

  it('leaves an unbound chord alone', () => {
    expect(stepHotkeySequence(null, 'Z', map, allEnabled)).toEqual({ kind: 'idle' });
  });

  it('re-evaluates a chord that completes nothing, rather than swallowing it', () => {
    // A stray `G` must not cost the user their next keystroke: `F1` still goes to Inventory.
    const step = stepHotkeySequence('G', 'F1', map, allEnabled);
    expect((step as { action: HotkeyAction }).action.id).toBe('nav.inventory');
  });

  it('goes idle when a pending prefix is followed by nothing meaningful', () => {
    expect(stepHotkeySequence('G', 'Z', map, allEnabled)).toEqual({ kind: 'idle' });
  });

  it('prefers an exact single-chord binding over arming a prefix of the same key', () => {
    // `G` is both Activity's own key and the prefix of `G R`; pressing it must do the thing
    // it is bound to, not silently wait for a second key that may never come.
    const both = bindings({ 'nav.activity': 'G', 'nav.reports': 'G R' });
    const step = stepHotkeySequence(null, 'G', both, allEnabled);
    expect((step as { action: HotkeyAction }).action.id).toBe('nav.activity');
  });

  it('does not arm a prefix whose only sequence belongs to a disabled action', () => {
    const onlyReports = (action: HotkeyAction) => action.id !== 'nav.reports';
    const map2 = bindings({ 'nav.reports': 'G R' });
    // Every other `G ` default is disabled too, so nothing should arm.
    const isEnabled = (action: HotkeyAction) =>
      onlyReports(action) && !DEFAULT_HOTKEY_BINDINGS[action.id].startsWith('G ');
    expect(stepHotkeySequence(null, 'G', map2, isEnabled)).toEqual({ kind: 'idle' });
  });
});

describe('findHotkeyConflictRivals', () => {
  it('names the other holder of a shared key, in both directions', () => {
    const clashing = bindings({ 'nav.reports': 'F1' }); // F1 is Inventory's
    const rivals = findHotkeyConflictRivals(clashing);
    expect(rivals.get('nav.reports')).toEqual(['nav.inventory']);
    expect(rivals.get('nav.inventory')).toEqual(['nav.reports']);
  });

  it('reports nothing when every binding is distinct', () => {
    expect(findHotkeyConflictRivals(bindings({})).size).toBe(0);
  });

  it('does not treat two unbound actions as a conflict', () => {
    const map = bindings({ 'nav.reports': '', 'nav.contacts': '' });
    expect(map['nav.reports']).toBe('');
    expect(findHotkeyConflictRivals(map).has('nav.reports')).toBe(false);
  });
});

describe('presets', () => {
  it('ships a Vim-flavoured scheme alongside the default', () => {
    expect(HOTKEY_PRESETS.map((p) => p.id)).toEqual(['default', 'vim']);
  });

  it('applies a preset over the shipped defaults, not over the current map', () => {
    const applied = applyHotkeyPreset('vim');
    expect(applied['nav.inventory']).toBe('G I');
    expect(applied['screen.new']).toBe('O');
  });

  it('leaves every preset internally conflict-free', () => {
    // A shipped scheme that collides with itself would hand the user a warning triangle the
    // moment they applied it.
    for (const preset of HOTKEY_PRESETS) {
      const applied = applyHotkeyPreset(preset.id);
      const rivals = findHotkeyConflictRivals(applied);
      expect(`${preset.id}: ${[...rivals.keys()].join(', ')}`).toBe(`${preset.id}: `);
    }
  });

  it('produces only valid bindings', () => {
    for (const preset of HOTKEY_PRESETS) {
      for (const binding of Object.values(applyHotkeyPreset(preset.id))) {
        expect(rejectBinding(binding), binding).toBeNull();
      }
    }
  });

  it('keeps the default preset identical to the shipped defaults', () => {
    expect(applyHotkeyPreset('default')).toEqual(DEFAULT_HOTKEY_BINDINGS);
  });
});

describe('the shipped defaults', () => {
  it('are free of conflicts out of the box', () => {
    expect([...findHotkeyConflictRivals(DEFAULT_HOTKEY_BINDINGS).keys()]).toEqual([]);
  });

  it('are all valid', () => {
    for (const [id, binding] of Object.entries(DEFAULT_HOTKEY_BINDINGS)) {
      expect(rejectBinding(binding), `${id} = ${binding}`).toBeNull();
    }
  });
});
