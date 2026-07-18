import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEY_BINDINGS,
  HOTKEY_ACTIONS,
  HOTKEY_ACTION_IDS,
  bindingFromEvent,
  displayBinding,
  findHotkeyConflicts,
  formatChord,
  isTypingTarget,
  normaliseHotkeyBindings,
  normaliseHotkeyKey,
  parseBinding,
  rejectBinding,
  resolveHotkeyAction,
  type HotkeyAction,
  type HotkeyActionId,
} from './hotkeys';

/** A keydown-shaped stand-in — the seam only ever reads these five fields. */
function press(
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
): { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
  };
}

const allEnabled = () => true;

describe('the action registry', () => {
  it('has a unique id for every action', () => {
    expect(new Set(HOTKEY_ACTION_IDS).size).toBe(HOTKEY_ACTIONS.length);
  });

  it('ships no default binding that the reserved-key rules would reject', () => {
    for (const action of HOTKEY_ACTIONS) {
      expect(rejectBinding(action.defaultBinding), action.id).toBeNull();
    }
  });

  it('ships no two actions sharing a default binding', () => {
    expect(findHotkeyConflicts(DEFAULT_HOTKEY_BINDINGS)).toEqual(new Set());
  });

  it('keeps the issue #32 default: F1 opens the Inventory', () => {
    expect(DEFAULT_HOTKEY_BINDINGS['nav.inventory']).toBe('F1');
  });

  it('keeps the command palette on its pre-existing Ctrl+/ chord', () => {
    expect(DEFAULT_HOTKEY_BINDINGS['command.palette']).toBe('Ctrl+/');
  });
});

describe('normaliseHotkeyKey', () => {
  it('upper-cases single characters so Shift+a and A are the same chord', () => {
    expect(normaliseHotkeyKey('a')).toBe('A');
    expect(normaliseHotkeyKey('A')).toBe('A');
  });

  it('spells the space bar so it survives the +-joined string', () => {
    expect(normaliseHotkeyKey(' ')).toBe('Space');
  });

  it('leaves named keys alone', () => {
    expect(normaliseHotkeyKey('F1')).toBe('F1');
    expect(normaliseHotkeyKey('ArrowDown')).toBe('ArrowDown');
  });
});

describe('reading a chord from a key press', () => {
  it('serialises modifiers in a fixed order regardless of the press', () => {
    expect(bindingFromEvent(press('i', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+I');
  });

  it('reads a bare function key', () => {
    expect(bindingFromEvent(press('F1'))).toBe('F1');
  });

  it('ignores a bare modifier — the user is still assembling the chord', () => {
    expect(bindingFromEvent(press('Control', { ctrl: true }))).toBeNull();
    expect(bindingFromEvent(press('Shift', { shift: true }))).toBeNull();
  });

  it('ignores a key the browser could not identify', () => {
    expect(bindingFromEvent(press('Unidentified'))).toBeNull();
  });

  it('round-trips through formatChord', () => {
    const chord = { ctrl: true, alt: false, shift: false, meta: false, key: '/' };
    expect(formatChord(chord)).toBe('Ctrl+/');
  });
});

describe('rejectBinding', () => {
  it('accepts the empty string — unbound is a valid, deliberate state', () => {
    expect(rejectBinding('')).toBeNull();
  });

  it('accepts a plain function key and a modifier chord', () => {
    expect(rejectBinding('F1')).toBeNull();
    expect(rejectBinding('Ctrl+Shift+K')).toBeNull();
  });

  it('rejects keys the browser will not let the page cancel', () => {
    expect(rejectBinding('F5')).toBe('reserved');
    expect(rejectBinding('F11')).toBe('reserved');
    expect(rejectBinding('F12')).toBe('reserved');
  });

  it('rejects browser-reserved tab/window chords', () => {
    expect(rejectBinding('Ctrl+W')).toBe('reserved');
    expect(rejectBinding('Ctrl+T')).toBe('reserved');
  });

  it('allows a reserved key once it is modified — Ctrl+F5 is ours to take', () => {
    expect(rejectBinding('Ctrl+F5')).toBeNull();
  });

  it('rejects a chord that is only modifiers', () => {
    expect(rejectBinding('Ctrl+Shift')).toBe('modifier-only');
  });

  it('rejects malformed modifier lists', () => {
    expect(rejectBinding('Hyper+K')).toBe('malformed');
    // Out of canonical order — never produced by formatChord, so it is corrupt input.
    expect(rejectBinding('Shift+Ctrl+K')).toBe('malformed');
    // The same modifier twice.
    expect(rejectBinding('Ctrl+Ctrl+K')).toBe('malformed');
    expect(rejectBinding('++K')).toBe('malformed');
  });

  it('accepts the + key, whose name collides with the separator', () => {
    expect(rejectBinding('+')).toBeNull();
    expect(rejectBinding('Ctrl++')).toBeNull();
    expect(rejectBinding('Ctrl+Shift++')).toBeNull();
  });
});

describe('parseBinding', () => {
  it('splits an ordinary chord', () => {
    expect(parseBinding('Ctrl+Shift+K')).toEqual({ modifiers: ['Ctrl', 'Shift'], key: 'K' });
  });

  it('reads a bare key as having no modifiers', () => {
    expect(parseBinding('F1')).toEqual({ modifiers: [], key: 'F1' });
  });

  it('reads the + key rather than an empty one — the separator collision', () => {
    expect(parseBinding('+')).toEqual({ modifiers: [], key: '+' });
    expect(parseBinding('Ctrl++')).toEqual({ modifiers: ['Ctrl'], key: '+' });
  });

  it('returns null for structurally broken input', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding('++K')).toBeNull();
  });

  it('round-trips whatever bindingFromEvent produces, including +', () => {
    for (const event of [press('+'), press('+', { ctrl: true }), press('F1'), press('/', { ctrl: true })]) {
      const binding = bindingFromEvent(event);
      expect(binding).not.toBeNull();
      expect(rejectBinding(binding as string), binding as string).toBeNull();
      expect(parseBinding(binding as string), binding as string).not.toBeNull();
    }
  });
});

describe('the macOS primary modifier', () => {
  it('folds a Command press into Ctrl, so one binding serves both platforms', () => {
    expect(bindingFromEvent(press('/', { meta: true }), true)).toBe('Ctrl+/');
  });

  it('keeps the long-standing Cmd+/ command-palette shortcut working on a Mac', () => {
    const bindings = normaliseHotkeyBindings({});
    const binding = bindingFromEvent(press('/', { meta: true }), true) as string;
    expect(resolveHotkeyAction(bindings, binding, allEnabled)?.id).toBe('command.palette');
  });

  it('leaves Meta alone off a Mac, where Command is not the primary modifier', () => {
    expect(bindingFromEvent(press('/', { meta: true }), false)).toBe('Meta+/');
  });

  it('does not double up when both Ctrl and Command are held', () => {
    expect(bindingFromEvent(press('K', { ctrl: true, meta: true }), true)).toBe('Ctrl+K');
  });

  it('renders the primary modifier as the Command glyph on a Mac', () => {
    expect(displayBinding('Ctrl+/', true)).toBe('⌘/');
  });
});

describe('normaliseHotkeyBindings', () => {
  it('returns a total map even from nothing at all', () => {
    for (const source of [undefined, null, 'nonsense', 42, {}]) {
      const out = normaliseHotkeyBindings(source);
      expect(Object.keys(out).sort()).toEqual([...HOTKEY_ACTION_IDS].sort());
    }
  });

  it('fills an action missing from an older persisted map with its shipped default', () => {
    const out = normaliseHotkeyBindings({ 'nav.inventory': 'Ctrl+I' });
    expect(out['nav.inventory']).toBe('Ctrl+I');
    expect(out['nav.dashboard']).toBe(DEFAULT_HOTKEY_BINDINGS['nav.dashboard']);
  });

  it('drops ids that no longer exist', () => {
    const out = normaliseHotkeyBindings({ 'nav.gone': 'F9' }) as Record<string, string>;
    expect(out['nav.gone']).toBeUndefined();
  });

  it('falls back to the default when a persisted binding has become unusable', () => {
    const out = normaliseHotkeyBindings({ 'nav.inventory': 'F5' });
    expect(out['nav.inventory']).toBe(DEFAULT_HOTKEY_BINDINGS['nav.inventory']);
  });

  it('keeps a deliberate unbinding rather than restoring the default over it', () => {
    expect(normaliseHotkeyBindings({ 'nav.inventory': '' })['nav.inventory']).toBe('');
  });

  it('keeps a duplicate — a conflict is the user’s to see and resolve, not ours to rewrite', () => {
    const out = normaliseHotkeyBindings({ 'nav.inventory': 'F7', 'nav.reports': 'F7' });
    expect(out['nav.inventory']).toBe('F7');
    expect(out['nav.reports']).toBe('F7');
  });
});

describe('findHotkeyConflicts', () => {
  it('reports both sides of a clash', () => {
    const bindings = normaliseHotkeyBindings({ 'nav.inventory': 'F7', 'nav.reports': 'F7' });
    expect(findHotkeyConflicts(bindings)).toEqual(new Set(['nav.inventory', 'nav.reports']));
  });

  it('does not treat several unbound actions as a conflict', () => {
    const bindings = normaliseHotkeyBindings(Object.fromEntries(HOTKEY_ACTION_IDS.map((id) => [id, ''])));
    expect(findHotkeyConflicts(bindings)).toEqual(new Set());
  });
});

describe('resolveHotkeyAction', () => {
  const bindings = normaliseHotkeyBindings({});

  it('finds the action bound to a chord', () => {
    expect(resolveHotkeyAction(bindings, 'F1', allEnabled)?.id).toBe('nav.inventory');
  });

  it('returns null for an unbound chord, leaving the press to the browser', () => {
    expect(resolveHotkeyAction(bindings, 'Ctrl+Shift+Q', allEnabled)).toBeNull();
  });

  it('never matches the empty binding, however many actions are unbound', () => {
    expect(resolveHotkeyAction(bindings, '', allEnabled)).toBeNull();
  });

  it('skips an action whose module is switched off', () => {
    const inventoryOff = (a: HotkeyAction) => a.feature !== 'inventory';
    expect(resolveHotkeyAction(bindings, 'F1', inventoryOff)).toBeNull();
  });

  it('breaks a duplicate-binding tie by registry order, so dispatch is deterministic', () => {
    const clashing = normaliseHotkeyBindings({ 'nav.inventory': 'F7', 'nav.reports': 'F7' });
    // Inventory sits above Reports in HOTKEY_ACTIONS, so it wins.
    expect(resolveHotkeyAction(clashing, 'F7', allEnabled)?.id).toBe('nav.inventory');
  });

  it('falls through to the loser of a tie when the winner is gated off', () => {
    const clashing = normaliseHotkeyBindings({ 'nav.inventory': 'F7', 'nav.reports': 'F7' });
    const inventoryOff = (a: HotkeyAction) => a.feature !== 'inventory';
    expect(resolveHotkeyAction(clashing, 'F7', inventoryOff)?.id).toBe('nav.reports');
  });
});

describe('displayBinding', () => {
  it('spells modifiers with + on a PC keyboard', () => {
    expect(displayBinding('Ctrl+Shift+K', false)).toBe('Ctrl+Shift+K');
  });

  it('uses the Mac glyphs, unseparated, on a Mac keyboard', () => {
    // `Ctrl` is the primary modifier, which on a Mac is the Command key the user actually presses.
    expect(displayBinding('Ctrl+Shift+K', true)).toBe('⌘⇧K');
    expect(displayBinding('Alt+K', true)).toBe('⌥K');
  });

  it('renders an unbound action as empty, leaving the copy to the caller', () => {
    expect(displayBinding('', false)).toBe('');
  });
});

describe('isTypingTarget', () => {
  it('stands aside for the fields that own their own keyboard', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName }), tagName).toBe(true);
    }
  });

  it('stands aside for a contenteditable region', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('stands aside for an open combobox, which handles its own keys', () => {
    expect(isTypingTarget({ tagName: 'DIV', getAttribute: () => 'combobox' })).toBe(true);
  });

  it('claims an ordinary element, and copes with no target at all', () => {
    expect(isTypingTarget({ tagName: 'DIV', getAttribute: () => null })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('the settings list and the shortcut list agree', () => {
  it('gives every action a distinct id used as its binding-map key', () => {
    const ids: HotkeyActionId[] = HOTKEY_ACTIONS.map((a) => a.id);
    expect(ids).toEqual(HOTKEY_ACTION_IDS);
  });
});
