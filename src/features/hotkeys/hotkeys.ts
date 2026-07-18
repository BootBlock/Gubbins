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
 *
 * **Sequences.** A binding may also be *two* chords typed in turn, separated by a space:
 * `G I` is "press G, then I" (the Gmail/Vim convention). This exists because comfortable single
 * keys are scarce — there are not enough of them to give every destination one, and spending a
 * modifier chord on each is worse. A sequence's first chord is a *prefix*: pressing it arms the
 * matcher rather than doing anything, and the next chord either completes a binding or cancels.
 * {@link stepHotkeySequence} is that matcher, kept pure so the arming/expiry rules are testable
 * without a browser; the timeout itself lives in the React hook.
 *
 * **Scopes.** Most actions are global, but two — "new" and "focus search" — mean something
 * different on every screen, which is the whole point of binding a bare `N` or `/` to them. Those
 * carry {@link HotkeyAction.scoped} and only fire when the screen currently on top has registered
 * a handler for them (see `useHotkeyScope`). An unhandled scoped press is left for the browser,
 * so `/` still types a slash on a screen that offers no search.
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

/**
 * The non-navigation commands a hotkey can trigger.
 *
 * The `screen-*` pair are the {@link HotkeyAction.scoped} ones: they carry no fixed meaning of
 * their own and are dispatched to whichever screen has registered a handler.
 */
export type HotkeyCommand =
  | 'command-palette'
  | 'open-settings'
  | 'open-hotkey-settings'
  | 'shortcuts-overlay'
  | 'add-item'
  | 'start-scan'
  | 'new-project'
  | 'new-purchase-order'
  | 'toggle-full-width'
  | 'toggle-theme'
  | 'screen-new'
  | 'screen-search';

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
  /**
   * A **contextual** action: its meaning comes from the screen you are on, so it fires only when
   * that screen has registered a handler (`useHotkeyScope`). This is what lets a bare `N` mean
   * "new project" on Projects and "new order" on Purchase orders without either spending its own
   * key — and what makes an unhandled press fall through to the browser untouched, so `/` still
   * types a slash where no search box exists.
   */
  readonly scoped?: true;
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
  | 'command.hotkeys'
  | 'command.shortcutsOverlay'
  | 'action.addItem'
  | 'action.startScan'
  | 'action.newProject'
  | 'action.newPurchaseOrder'
  | 'action.toggleFullWidth'
  | 'action.toggleTheme'
  | 'screen.new'
  | 'screen.search';

/**
 * Every rebindable action, in the order the Settings list shows them.
 *
 * **Choosing the shipped defaults.** The set stays small enough to remember: the four everyday
 * workspaces on `F1`–`F4` (issue #32 asks for `F1` → Inventory specifically), and the two
 * conventional app chords `Ctrl+/` (command palette, unchanged from before hotkeys existed) and
 * `Ctrl+,` (settings — the near-universal preferences shortcut).
 *
 * The remaining destinations now ship on `G` **sequences** (`G R` → Reports) rather than unbound.
 * That was the original reason they had no default at all: a single comfortable key per screen is
 * a budget that runs out after about four, and a modifier chord each is harder to recall than it
 * is to type. A two-key sequence costs one prefix key for the whole set (issue #127).
 *
 * Three more ship bound because they are the conventions users arrive expecting: `?` for the
 * shortcut list, and the contextual `N` / `/` for "new" and "focus search" on whichever screen is
 * open. The rest of the commands appear in the list ready to be given a key, which keeps the
 * default surface honest without limiting anyone.
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
    defaultBinding: 'G R',
    effect: { kind: 'navigate', to: '/reports' },
    feature: 'reports',
  },
  {
    id: 'nav.contacts',
    label: 'Contacts',
    messageKey: 'nav.contacts',
    defaultBinding: 'G C',
    effect: { kind: 'navigate', to: '/contacts' },
    feature: 'contacts',
  },
  {
    id: 'nav.bookings',
    label: 'Bookings',
    messageKey: 'nav.bookings',
    defaultBinding: 'G B',
    effect: { kind: 'navigate', to: '/bookings' },
    feature: 'bookings',
  },
  {
    id: 'nav.upcoming',
    label: 'Upcoming',
    messageKey: 'nav.upcoming',
    defaultBinding: 'G U',
    effect: { kind: 'navigate', to: '/upcoming' },
    feature: 'upcoming',
  },
  {
    id: 'nav.activity',
    label: 'Activity',
    messageKey: 'nav.activity',
    defaultBinding: 'G A',
    effect: { kind: 'navigate', to: '/activity' },
    feature: 'activity',
  },
  {
    // `G L` rather than `G A` — Activity took the initial, so Alerts uses the next letter that
    // is unmistakably its own rather than a second-choice initial nobody would guess.
    id: 'nav.alerts',
    label: 'Alerts',
    messageKey: 'nav.alerts',
    defaultBinding: 'G L',
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
  {
    // `?` is the near-universal "what are my shortcuts" key, so it ships bound — the cheat sheet
    // is what makes every other binding discoverable, and a discoverability aid nobody can find
    // is no aid at all.
    id: 'command.shortcutsOverlay',
    label: 'Show keyboard shortcuts',
    messageKey: 'hotkeys.action.shortcutsOverlay',
    defaultBinding: '?',
    effect: { kind: 'command', command: 'shortcuts-overlay' },
  },
  {
    id: 'action.addItem',
    label: 'Add item',
    messageKey: 'hotkeys.action.addItem',
    defaultBinding: '',
    effect: { kind: 'command', command: 'add-item' },
    feature: 'inventory',
  },
  {
    id: 'action.startScan',
    label: 'Start a scan',
    messageKey: 'hotkeys.action.startScan',
    defaultBinding: '',
    effect: { kind: 'command', command: 'start-scan' },
    feature: 'inventory',
  },
  {
    id: 'action.newProject',
    label: 'New project',
    messageKey: 'hotkeys.action.newProject',
    defaultBinding: '',
    effect: { kind: 'command', command: 'new-project' },
    feature: 'projects',
  },
  {
    id: 'action.newPurchaseOrder',
    label: 'New purchase order',
    messageKey: 'hotkeys.action.newPurchaseOrder',
    defaultBinding: '',
    effect: { kind: 'command', command: 'new-purchase-order' },
    feature: 'purchase-orders',
  },
  {
    id: 'action.toggleFullWidth',
    label: 'Toggle full width',
    messageKey: 'hotkeys.action.toggleFullWidth',
    defaultBinding: '',
    effect: { kind: 'command', command: 'toggle-full-width' },
  },
  {
    id: 'action.toggleTheme',
    label: 'Toggle light/dark',
    messageKey: 'hotkeys.action.toggleTheme',
    defaultBinding: '',
    effect: { kind: 'command', command: 'toggle-theme' },
  },
  {
    // Contextual (see `scoped`): bare `N` and `/` are only affordable because they mean whatever
    // the screen in front of you says they mean, and stay out of the way where nothing claims them.
    id: 'screen.new',
    label: 'New (current screen)',
    messageKey: 'hotkeys.action.screenNew',
    defaultBinding: 'N',
    effect: { kind: 'command', command: 'screen-new' },
    scoped: true,
  },
  {
    id: 'screen.search',
    label: 'Focus search (current screen)',
    messageKey: 'hotkeys.action.screenSearch',
    defaultBinding: '/',
    effect: { kind: 'command', command: 'screen-search' },
    scoped: true,
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
 *
 * Shift is likewise dropped when the key is a **shifted punctuation character**, because the
 * character already encodes the Shift: `?` is what the keyboard reports for Shift+/, so keeping
 * the flag would store it as `Shift+?` — a chord that reads like it needs Shift pressed twice,
 * and that a different layout (where `?` is unshifted) would never reproduce. Letters and digits
 * keep the flag, since `Shift+A` and `A` are genuinely different bindings.
 *
 * "Letter" is decided by Unicode property, not an `A-Z` range: on a German layout `Ä` is a letter
 * that `A-Z` would miss, and dropping Shift there would store `Shift+Ä` as plain `Ä` — so pressing
 * the *unshifted* `ä` would then fire a shortcut the user bound to the shifted key.
 */
export function chordFromEvent(event: HotkeyKeyEvent, isMac = false): HotkeyChord | null {
  if (event.key === '' || event.key === 'Unidentified' || MODIFIER_KEYS.has(event.key)) return null;
  const commandIsPrimary = isMac && event.metaKey;
  const key = normaliseHotkeyKey(event.key);
  const shiftIsInTheCharacter = key.length === 1 && !/[\p{L}\p{N}]/u.test(key);
  return {
    ctrl: event.ctrlKey || commandIsPrimary,
    alt: event.altKey,
    shift: event.shiftKey && !shiftIsInTheCharacter,
    meta: event.metaKey && !commandIsPrimary,
    key,
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

/**
 * The separator between the two chords of a sequence binding (`G I`). A space can never be part
 * of a chord — the space *key* serialises as `Space` (see {@link normaliseHotkeyKey}) precisely
 * so it survives this split.
 */
export const SEQUENCE_SEPARATOR = ' ';

/** The most chords one binding may chain. Two is the whole convention; three is a code. */
export const MAX_SEQUENCE_LENGTH = 2;

/**
 * Split a binding into its chords: one for an ordinary chord binding, two for a sequence.
 * Returns `null` for `''` (unbound) or a structurally broken string.
 */
export function parseSequence(binding: HotkeyBinding): readonly string[] | null {
  if (binding === '') return null;
  const steps = binding.split(SEQUENCE_SEPARATOR);
  if (steps.length > MAX_SEQUENCE_LENGTH) return null;
  return steps.some((s) => s === '') ? null : steps;
}

/** Whether a binding is a two-chord sequence rather than a single chord. */
export function isSequenceBinding(binding: HotkeyBinding): boolean {
  const steps = parseSequence(binding);
  return steps !== null && steps.length > 1;
}

/** Why a candidate binding can't be used — `null` when it's fine. */
export type HotkeyRejection = 'reserved' | 'modifier-only' | 'malformed';

/** Validate one chord of a binding (the whole thing, for a non-sequence binding). */
function rejectChord(chord: string): HotkeyRejection | null {
  const parsed = parseBinding(chord);
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
  if (RESERVED_CHORDS.has(chord)) return 'reserved';
  return null;
}

/**
 * Validate a candidate binding string. Returns `null` when it is usable (including `''`,
 * which means "unbind"), otherwise the reason so the UI can explain the refusal rather than
 * silently dropping the choice.
 *
 * Every chord of a sequence is validated, so `G F5` is rejected for the same reason `F5` is.
 */
export function rejectBinding(binding: HotkeyBinding): HotkeyRejection | null {
  if (binding === '') return null;
  const steps = parseSequence(binding);
  if (steps === null) return 'malformed';
  for (const step of steps) {
    const rejection = rejectChord(step);
    if (rejection !== null) return rejection;
  }
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
 * What one key press means to the sequence matcher.
 *
 * - `idle` — not ours (or a sequence that went nowhere). The press is left for the browser.
 * - `pending` — the chord opened a sequence; hold it and wait for the next chord. The caller
 *   claims the press (so `G` alone doesn't type into anything) and starts an expiry timer.
 * - `fire` — run this action.
 */
export type HotkeyStep =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly prefix: string }
  | { readonly kind: 'fire'; readonly action: HotkeyAction };

/** Whether `chord` opens some enabled sequence binding — i.e. is worth arming the matcher for. */
function isSequencePrefix(
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
  chord: string,
  isEnabled: (action: HotkeyAction) => boolean,
): boolean {
  return HOTKEY_ACTIONS.some((action) => {
    const steps = parseSequence(bindings[action.id] ?? '');
    return steps !== null && steps.length > 1 && steps[0] === chord && isEnabled(action);
  });
}

/**
 * Advance the two-key sequence matcher by one chord (issue #127).
 *
 * The whole point of a sequence is that its first chord is *inert* — pressing `G` must do
 * nothing visible and commit to nothing, because the user has not yet said which screen they
 * want. So this is a two-state machine, and the interesting rules are the recovery ones:
 *
 * - A pending prefix that the next chord doesn't complete does **not** simply swallow that
 *   chord. It is re-evaluated as a fresh press, so a stray `G` followed by `F1` still goes to
 *   Inventory rather than silently eating a shortcut the user meant.
 * - An exact single-chord binding wins over arming a prefix, so a key that is *both* can still
 *   be pressed for its own action; only a key with no binding of its own becomes a pure prefix.
 *
 * Expiry is the caller's job (a timer, cleared on the next press) — time is not something a pure
 * function should read.
 */
export function stepHotkeySequence(
  pending: string | null,
  chord: string,
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
  isEnabled: (action: HotkeyAction) => boolean,
): HotkeyStep {
  if (pending !== null) {
    const completed = resolveHotkeyAction(bindings, `${pending}${SEQUENCE_SEPARATOR}${chord}`, isEnabled);
    if (completed !== null) return { kind: 'fire', action: completed };
    // Fell through: re-evaluate as a fresh press rather than eating it (see the docstring).
  }
  const exact = resolveHotkeyAction(bindings, chord, isEnabled);
  if (exact !== null) return { kind: 'fire', action: exact };
  if (isSequencePrefix(bindings, chord, isEnabled)) return { kind: 'pending', prefix: chord };
  return { kind: 'idle' };
}

/**
 * For each conflicting action, the *other* actions holding the same key (issue #127).
 *
 * This is the single source of truth for "what clashes with what": {@link findHotkeyConflicts} is
 * derived from it, so the warning triangle and the inline "unbind the other one" offer can never
 * disagree about whether a row is in trouble.
 *
 * Unbound actions never conflict — any number of them may be unbound.
 */
export function findHotkeyConflictRivals(
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
): ReadonlyMap<HotkeyActionId, readonly HotkeyActionId[]> {
  const byBinding = new Map<HotkeyBinding, HotkeyActionId[]>();
  for (const id of HOTKEY_ACTION_IDS) {
    const binding = bindings[id];
    if (binding === '') continue;
    const bucket = byBinding.get(binding);
    if (bucket) bucket.push(id);
    else byBinding.set(binding, [id]);
  }
  const rivals = new Map<HotkeyActionId, readonly HotkeyActionId[]>();
  for (const ids of byBinding.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      rivals.set(
        id,
        ids.filter((other) => other !== id),
      );
    }
  }
  return rivals;
}

/**
 * The ids of actions sharing a binding with another action — what the Settings list marks as
 * conflicting. A thin view over {@link findHotkeyConflictRivals}: an action conflicts exactly
 * when it has at least one rival.
 */
export function findHotkeyConflicts(
  bindings: Readonly<Record<HotkeyActionId, HotkeyBinding>>,
): ReadonlySet<HotkeyActionId> {
  return new Set(findHotkeyConflictRivals(bindings).keys());
}

/** A ready-made scheme the user can adopt instead of rebinding a dozen rows by hand. */
export interface HotkeyPreset {
  readonly id: HotkeyPresetId;
  readonly label: string;
  readonly messageKey: MessageKey;
  /**
   * The bindings this preset sets. Sparse by design: an action the preset doesn't mention keeps
   * its shipped default, so adding an action to the registry later doesn't silently unbind it
   * for everyone on a preset.
   */
  readonly bindings: Readonly<Partial<Record<HotkeyActionId, HotkeyBinding>>>;
}

export type HotkeyPresetId = 'default' | 'vim';

/**
 * The shipped preset schemes (issue #127).
 *
 * A preset is a *starting point*, not a mode: applying one writes ordinary bindings the user can
 * then edit row by row. Nothing remembers which preset was applied, because the moment one row is
 * changed the answer would be a lie.
 */
export const HOTKEY_PRESETS: readonly HotkeyPreset[] = [
  {
    id: 'default',
    label: 'Gubbins default',
    messageKey: 'hotkeys.preset.default',
    bindings: DEFAULT_HOTKEY_BINDINGS,
  },
  {
    // Vim-flavoured: `g`-prefixed goto sequences for every destination (so the function keys are
    // handed back), plus Vim's own `/` for search and its `i`/`o` verbs for the create actions.
    id: 'vim',
    label: 'Vim-flavoured',
    messageKey: 'hotkeys.preset.vim',
    bindings: {
      'nav.dashboard': 'G D',
      'nav.inventory': 'G I',
      'nav.projects': 'G P',
      'nav.purchaseOrders': 'G O',
      'nav.reports': 'G R',
      'nav.contacts': 'G C',
      'nav.bookings': 'G B',
      'nav.upcoming': 'G U',
      'nav.activity': 'G A',
      'nav.alerts': 'G L',
      'command.palette': 'Ctrl+/',
      'command.settings': 'G S',
      'command.hotkeys': 'G K',
      'command.shortcutsOverlay': '?',
      'action.addItem': 'I',
      'action.startScan': 'G N',
      'action.newProject': 'G Shift+P',
      'action.newPurchaseOrder': 'G Shift+O',
      'action.toggleFullWidth': 'G W',
      'action.toggleTheme': 'G T',
      'screen.new': 'O',
      'screen.search': '/',
    },
  },
];

/**
 * Apply a preset over the shipped defaults, producing a complete binding map.
 *
 * Layered over {@link DEFAULT_HOTKEY_BINDINGS} rather than over the user's current map: a preset
 * is "start again from this scheme", so leaving unmentioned actions on whatever the user had
 * would produce a hybrid that matches neither what they picked nor what they left.
 */
export function applyHotkeyPreset(id: HotkeyPresetId): Record<HotkeyActionId, HotkeyBinding> {
  const preset = HOTKEY_PRESETS.find((p) => p.id === id);
  return normaliseHotkeyBindings({ ...DEFAULT_HOTKEY_BINDINGS, ...(preset?.bindings ?? {}) });
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
  const steps = parseSequence(binding);
  if (steps === null) return '';
  const shown = steps.map((step) => displayChord(step, isMac));
  // A sequence is spelled "then" rather than joined, so `G R` can't be misread as one chord
  // where both keys are held down — the distinction the whole feature turns on.
  return shown.some((s) => s === '') ? '' : shown.join(SEQUENCE_SEPARATOR);
}

/** Render one chord of a binding; `''` when it is structurally broken. */
function displayChord(chord: string, isMac: boolean): string {
  const parsed = parseBinding(chord);
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
