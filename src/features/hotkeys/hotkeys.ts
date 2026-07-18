/**
 * Global keyboard shortcuts — the pure seam (issue #32).
 *
 * One registry of every rebindable action, plus the DOM-free logic for turning a key press
 * into a canonical binding string, matching it back to an action, and reconciling a stale
 * persisted binding map. Everything here is a total function over plain data so the rules
 * (what a valid chord is, which keys the browser reserves, how conflicts are detected) are
 * unit-testable without a browser — the `focus-trap.ts` / `modal-stack.ts` seam pattern.
 *
 * The React side is thin by design: {@link useGlobalHotkeys} listens once at the app root,
 * asks {@link resolveHotkeyAction} what the press means, and performs it.
 *
 * **Binding format.** A binding is a single chord, serialised as modifiers in a fixed order
 * followed by the key: `Ctrl+Shift+I`, `Alt+F1`, `F1`, `Ctrl+/`. The empty string means
 * *unbound* — a first-class state, since most destinations ship without a default so the
 * shipped set stays small and memorable. Note that `+` is both the separator and a bindable
 * key, so a binding is always parsed with {@link parseBinding} (which splits from the right)
 * rather than a bare `split('+')` — otherwise `Ctrl++` reads as a chord with an empty key.
 *
 * **The primary modifier.** `Ctrl` in a stored binding means "the platform's primary modifier":
 * Control on Windows/Linux, and **Command** on macOS, where Control is not what an app chord
 * uses. A Cmd press is therefore folded to `Ctrl` when a chord is recorded, and rendered back
 * as `⌘` for display, so one stored `Ctrl+/` is the right key on every platform — and the
 * long-standing Cmd+/ command-palette shortcut keeps working on a Mac.
 */
import type { AppRoutePath } from '@/components/nav/nav-destinations';
import type { FeatureId } from '@/features/modules/feature-registry';
import type { MessageKey } from '@/features/i18n';

/**
 * Whether this device's keyboard uses the Mac modifier conventions — which decides both how a
 * chord is recorded (Command folds into the primary modifier) and how it is spelled on screen.
 * Read from the UA: a keyboard does not change platform mid-session, and the check is guarded
 * so it stays `false` under a non-browser test environment.
 */
export function isMacKeyboard(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.platform` is deprecated but remains the most reliable Mac signal; fall back to
  // the UA string where it has already been removed.
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** A parsed chord: the modifier flags plus the (normalised) main key. */
export interface HotkeyChord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** The Command key on macOS / Windows key elsewhere. */
  readonly meta: boolean;
  /** The main key, normalised: `F1`, `A`, `/`, `Enter`, `Space`. */
  readonly key: string;
}

/** The serialised form stored in preferences; `''` means unbound. */
export type HotkeyBinding = string;

/**
 * Keys the browser (or the OS) claims for itself and will not reliably let a page intercept,
 * so binding one would produce a shortcut that silently does nothing — or worse, fights the
 * user's muscle memory. Rejected at bind time with an explanation rather than accepted and
 * quietly broken.
 *
 * `F5` reloads, `F11` toggles browser fullscreen and `F12` opens developer tools; none of
 * them can be cancelled from script in Chromium. Bare modifiers are not a chord at all.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['F5', 'F11', 'F12']);

/** Keys that are only ever a modifier — never a chord's main key. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/**
 * Chords the browser reserves *with* modifiers — closing/opening tabs and windows. Same
 * reasoning as {@link RESERVED_KEYS}: unpreventable in Chromium, so never offer them.
 */
const RESERVED_CHORDS: ReadonlySet<string> = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+W']);

/** What an action does when its hotkey fires. */
export type HotkeyEffect =
  /** Navigate to a route (Settings is a dialog, so it uses `openSettings` instead). */
  | { readonly kind: 'navigate'; readonly to: AppRoutePath }
  /** Run a named app command, dispatched by {@link useGlobalHotkeys}. */
  | { readonly kind: 'command'; readonly command: HotkeyCommand };

/** The non-navigation commands a hotkey can trigger. */
export type HotkeyCommand = 'command-palette' | 'open-settings' | 'open-hotkey-settings';

export interface HotkeyAction {
  readonly id: HotkeyActionId;
  /**
   * The English label — the stable identifier used for the settings list and as the i18n
   * fallback. For a navigation action this equals the destination's nav label, so the two
   * lists read identically (asserted by a drift test).
   */
  readonly label: string;
  /** i18n key for the displayed label; its English value in `en.json` equals {@link label}. */
  readonly messageKey: MessageKey;
  /** The shipped default binding, or `''` when the action ships unbound but rebindable. */
  readonly defaultBinding: HotkeyBinding;
  readonly effect: HotkeyEffect;
  /**
   * The Modular UI feature this action belongs to, or `undefined` when always available.
   * A hotkey whose feature is switched off neither fires nor appears in the settings list —
   * exactly how the nav and command palette hide the destination itself.
   */
  readonly feature?: FeatureId;
  /**
   * An additional preference that must be on for this action to fire, beyond its
   * {@link feature} gate. Only the command palette has one (`dashboardCommandPalette`),
   * which already gated its shortcut before hotkeys existed.
   */
  readonly requiresPref?: 'dashboardCommandPalette';
}

export type HotkeyActionId =
  | 'nav.dashboard'
  | 'nav.inventory'
  | 'nav.projects'
  | 'nav.purchaseOrders'
  | 'nav.reports'
  | 'nav.contacts'
  | 'nav.bookings'
  | 'nav.upcoming'
  | 'nav.activity'
  | 'nav.alerts'
  | 'command.palette'
  | 'command.settings'
  | 'command.hotkeys';

/**
 * Every rebindable action, in the order the Settings list shows them.
 *
 * **Choosing the shipped defaults.** Only the highest-traffic destinations get one, so the
 * out-of-the-box set stays small enough to remember: the four everyday workspaces on `F1`–`F4`
 * (issue #32 asks for `F1` → Inventory specifically), and the two conventional app chords
 * `Ctrl+/` (command palette, unchanged from before hotkeys existed) and `Ctrl+,` (settings —
 * the near-universal preferences shortcut). Everything else ships unbound but appears in the
 * list ready to be given a key, which keeps the default surface honest without limiting anyone.
 */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  {
    id: 'nav.inventory',
    label: 'Inventory',
    messageKey: 'nav.inventory',
    defaultBinding: 'F1',
    effect: { kind: 'navigate', to: '/inventory' },
    feature: 'inventory',
  },
  {
    id: 'nav.dashboard',
    label: 'Dashboard',
    messageKey: 'nav.dashboard',
    defaultBinding: 'F2',
    effect: { kind: 'navigate', to: '/' },
    feature: 'dashboard',
  },
  {
    id: 'nav.projects',
    label: 'Projects',
    messageKey: 'nav.projects',
    defaultBinding: 'F3',
    effect: { kind: 'navigate', to: '/projects' },
    feature: 'projects',
  },
  {
    id: 'nav.purchaseOrders',
    label: 'Purchase orders',
    messageKey: 'nav.purchaseOrders',
    defaultBinding: 'F4',
    effect: { kind: 'navigate', to: '/purchase-orders' },
    feature: 'purchase-orders',
  },
  {
    id: 'nav.reports',
    label: 'Reports',
    messageKey: 'nav.reports',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/reports' },
    feature: 'reports',
  },
  {
    id: 'nav.contacts',
    label: 'Contacts',
    messageKey: 'nav.contacts',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/contacts' },
    feature: 'contacts',
  },
  {
    id: 'nav.bookings',
    label: 'Bookings',
    messageKey: 'nav.bookings',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/bookings' },
    feature: 'bookings',
  },
  {
    id: 'nav.upcoming',
    label: 'Upcoming',
    messageKey: 'nav.upcoming',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/upcoming' },
    feature: 'upcoming',
  },
  {
    id: 'nav.activity',
    label: 'Activity',
    messageKey: 'nav.activity',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/activity' },
    feature: 'activity',
  },
  {
    id: 'nav.alerts',
    label: 'Alerts',
    messageKey: 'nav.alerts',
    defaultBinding: '',
    effect: { kind: 'navigate', to: '/alerts' },
    feature: 'alerts',
  },
  {
    id: 'command.palette',
    label: 'Command palette',
    messageKey: 'hotkeys.action.commandPalette',
    defaultBinding: 'Ctrl+/',
    effect: { kind: 'command', command: 'command-palette' },
    requiresPref: 'dashboardCommandPalette',
  },
  {
    id: 'command.settings',
    label: 'Settings',
    messageKey: 'hotkeys.action.settings',
    defaultBinding: 'Ctrl+,',
    effect: { kind: 'command', command: 'open-settings' },
    feature: 'settings',
  },
  {
    id: 'command.hotkeys',
    label: 'Keyboard shortcuts',
    messageKey: 'hotkeys.action.hotkeys',
    defaultBinding: '',
    effect: { kind: 'command', command: 'open-hotkey-settings' },
    feature: 'settings',
  },
];

/** Every action id, for total-map construction and validation. */
export const HOTKEY_ACTION_IDS: readonly HotkeyActionId[] = HOTKEY_ACTIONS.map((a) => a.id);

const ACTIONS_BY_ID = new Map<HotkeyActionId, HotkeyAction>(HOTKEY_ACTIONS.map((a) => [a.id, a]));

/** Look up one action's definition, or `undefined` for an unknown (stale) id. */
export function hotkeyAction(id: HotkeyActionId): HotkeyAction | undefined {
  return ACTIONS_BY_ID.get(id);
}

/** The shipped binding map — the defaults, and the fallback for anything unreadable. */
export const DEFAULT_HOTKEY_BINDINGS: Readonly<Record<HotkeyActionId, HotkeyBinding>> = Object.freeze(
  Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, a.defaultBinding])) as Record<
    HotkeyActionId,
    HotkeyBinding
  >,
);

/**
 * Normalise one key name into the canonical form used in a binding string.
 *
 * `KeyboardEvent.key` is case- and layout-sensitive (`a` vs `A` depending on Shift, `Escape`
 * vs `Esc` historically), so a chord recorded with Shift held would otherwise never match the
 * same chord replayed. Single characters upper-case; named keys keep their spelling, with
 * `' '` spelled `Space` so it survives a round-trip through the `+`-joined string.
 */
export function normaliseHotkeyKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Serialise a chord into its canonical string (modifiers in a fixed order, then the key). */
export function formatChord(chord: HotkeyChord): HotkeyBinding {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(normaliseHotkeyKey(chord.key));
  return parts.join('+');
}

/** The five fields the seam reads off a keydown — kept structural so it stays DOM-free. */
export interface HotkeyKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Read a chord out of a keyboard event, or `null` when the press isn't a usable chord —
 * a bare modifier (the user is still assembling the chord) or a key with no name.
 *
 * On macOS the Command key is folded into `ctrl` (see the module docstring): it is the
 * primary modifier there, so `⌘/` and `Ctrl+/` are one stored binding rather than two the
 * user would have to set separately.
 */
export function chordFromEvent(event: HotkeyKeyEvent, isMac = false): HotkeyChord | null {
  if (event.key === '' || event.key === 'Unidentified' || MODIFIER_KEYS.has(event.key)) return null;
  const commandIsPrimary = isMac && event.metaKey;
  return {
    ctrl: event.ctrlKey || commandIsPrimary,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey && !commandIsPrimary,
    key: normaliseHotkeyKey(event.key),
  };
}

/** The canonical binding string for a key press, or `null` when it isn't a usable chord. */
export function bindingFromEvent(event: HotkeyKeyEvent, isMac = false): HotkeyBinding | null {
  const chord = chordFromEvent(event, isMac);
  return chord === null ? null : formatChord(chord);
}

/**
 * Split a binding into its modifiers and key.
 *
 * Parsed from the **right**, because `+` is both the separator and a perfectly ordinary key:
 * a naive `split('+')` turns `Ctrl++` into `['Ctrl','','']` and reads the key as empty, so
 * the `+` key could never be bound. Returns `null` for a structurally broken string.
 */
export function parseBinding(
  binding: HotkeyBinding,
): { readonly modifiers: readonly string[]; readonly key: string } | null {
  if (binding === '') return null;
  // A trailing `+` is the literal plus key; everything before it is the modifier prefix.
  const isPlusKey = binding.endsWith('+');
  const key = isPlusKey ? '+' : binding.slice(binding.lastIndexOf('+') + 1);
  const prefix = binding.slice(0, binding.length - key.length);
  if (key === '') return null;
  // The prefix is either empty (no modifiers) or `Mod+` / `Mod+Mod+…`, so it ends in `+`.
  if (prefix === '') return { modifiers: [], key };
  if (!prefix.endsWith('+')) return null;
  const modifiers = prefix.slice(0, -1).split('+');
  return modifiers.some((m) => m === '') ? null : { modifiers, key };
}

/** Why a candidate binding can't be used — `null` when it's fine. */
export type HotkeyRejection = 'reserved' | 'modifier-only' | 'malformed';

/**
 * Validate a candidate binding string. Returns `null` when it is usable (including `''`,
 * which means "unbind"), otherwise the reason so the UI can explain the refusal rather than
 * silently dropping the choice.
 */
export function rejectBinding(binding: HotkeyBinding): HotkeyRejection | null {
  if (binding === '') return null;
  const parsed = parseBinding(binding);
  if (parsed === null) return 'malformed';
  const { modifiers, key } = parsed;
  if (MODIFIER_KEYS.has(key)) return 'modifier-only';
  // Every leading part must be a real modifier, listed once, in canonical order.
  const canonical = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  let cursor = 0;
  for (const modifier of modifiers) {
    const at = canonical.indexOf(modifier, cursor);
    if (at < 0) return 'malformed';
    cursor = at + 1;
  }
  if (RESERVED_KEYS.has(key) && modifiers.length === 0) return 'reserved';
  if (RESERVED_CHORDS.has(binding)) return 'reserved';
  return null;
}

/**
 * Reconcile a persisted binding map into a total, valid one.
 *
 * Persisted values are the user's *intent* and may be stale (an action that no longer exists,
 * a binding that has since become reserved) or partial (written by an older version that
 * shipped fewer actions). Rather than trusting it at the dispatch site, this coerces it once:
 * unknown ids are dropped, unusable bindings fall back to that action's shipped default, and
 * every current action is guaranteed present. A duplicate is *kept* — it is a real conflict
 * the user can see and resolve in Settings, not something to silently rewrite behind them.
 */
export function normaliseHotkeyBindings(value: unknown): Record<HotkeyActionId, HotkeyBinding> {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const out = {} as Record<HotkeyActionId, HotkeyBinding>;
  for (const action of HOTKEY_ACTIONS) {
    const raw = source[action.id];
    out[action.id] = typeof raw === 'string' && rejectBinding(raw) === null ? raw : action.defaultBinding;
  }
  return out;
}

/**
 * The action a key press should run, or `null` for "not a hotkey — leave the press alone".
 *
 * Registry order breaks a tie, so a duplicated binding is deterministic (the topmost action in
 * the Settings list wins) rather than order-of-iteration luck. `enabled` filters out actions
 * whose module is switched off, so a hidden screen's shortcut can't navigate to it.
 */
export function resolveHotkeyAction(
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
  binding: HotkeyBinding,
  isEnabled: (action: HotkeyAction) => boolean,
): HotkeyAction | null {
  if (binding === '') return null;
  for (const action of HOTKEY_ACTIONS) {
    if (bindings[action.id] === binding && isEnabled(action)) return action;
  }
  return null;
}

/**
 * The ids of actions sharing a binding with another action — what the Settings list marks as
 * conflicting. Unbound actions never conflict (any number may be unbound).
 */
export function findHotkeyConflicts(
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
): ReadonlySet<HotkeyActionId> {
  const seen = new Map<HotkeyBinding, HotkeyActionId[]>();
  for (const id of HOTKEY_ACTION_IDS) {
    const binding = bindings[id];
    if (binding === '') continue;
    const bucket = seen.get(binding);
    if (bucket) bucket.push(id);
    else seen.set(binding, [id]);
  }
  const conflicts = new Set<HotkeyActionId>();
  for (const ids of seen.values()) {
    if (ids.length > 1) for (const id of ids) conflicts.add(id);
  }
  return conflicts;
}

/**
 * Render a binding for display, spelling the modifiers the way the platform does — `⌘` and
 * `⌥` on a Mac, `Ctrl`/`Alt` everywhere else — so the caps match the user's own keyboard.
 * An unbound action renders as `''`; the caller supplies its own "not set" copy.
 *
 * `Ctrl` renders as `⌘` on a Mac because that is what it *is* there — the primary modifier
 * (see the module docstring), which is also the key the user pressed to record it.
 */
export function displayBinding(binding: HotkeyBinding, isMac: boolean): string {
  const parsed = parseBinding(binding);
  if (parsed === null) return '';
  const modifiers = parsed.modifiers.map((m) => {
    if (!isMac) return m;
    if (m === 'Ctrl') return '⌘';
    if (m === 'Alt') return '⌥';
    if (m === 'Shift') return '⇧';
    return '⌘';
  });
  return [...modifiers, parsed.key].join(isMac ? '' : '+');
}

/**
 * Whether a key press landed somewhere that owns its own keyboard input, so a global hotkey
 * must stand aside. Typing `F1` into a text field, a `contenteditable` note or an open
 * combobox must never navigate away mid-sentence.
 *
 * Takes the minimal shape rather than an `EventTarget` so it stays DOM-free and testable.
 */
export function isTypingTarget(
  target: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
    readonly getAttribute?: (name: string) => string | null;
  } | null,
): boolean {
  if (target === null || target === undefined) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable === true) return true;
  const role = target.getAttribute?.('role');
  return role === 'combobox' || role === 'textbox' || role === 'searchbox';
}
