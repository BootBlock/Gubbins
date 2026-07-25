/**
 * Live settings sync — the **pure** seam (issue #382).
 *
 * Cloud sync reconciles database rows by Last-Write-Wins on a per-row `updated_at`. Preferences
 * are not rows: they are one `localStorage` JSON blob per Zustand store, with no per-preference
 * identity and no timestamp. So "sync my settings" is a data-model question before it is a sync
 * question, and this module is the answer to it — the translation between the blob the stores live
 * in and the addressable `settings` rows the sync engine already knows how to reconcile.
 *
 * The blob stays the source of truth. It hydrates synchronously before first paint, works offline
 * and costs no query, and moving ~70 preferences and their 200-odd read sites into an async table
 * would trade all of that away for nothing the user asked for. Instead the `settings` table is a
 * **shared noticeboard**: this device publishes a row when the user changes an eligible preference,
 * and adopts a row when a sync brings in a newer one from a peer. Two consequences worth stating,
 * because the whole design rests on them:
 *
 *  - **Per-preference reconciliation falls out for free.** One row per (store, field) with a
 *    derived id means changing the theme on a phone and the low-stock threshold on a desktop touch
 *    different rows, so neither clobbers the other — the failure the issue set out to avoid.
 *  - **Applying after a merge is always correct.** A local change publishes its row *before* the
 *    sync pushes, so the merge weighs the user's edit against the peer's on real timestamps. Once
 *    it has, the winning row is authoritative by construction: if our edit won, applying it back is
 *    a no-op; if the peer's won, applying it is exactly what LWW decided.
 *
 * Eligibility is not decided here — it is derived from the settings-group registry that issue #175
 * already built for the backup picker (`features/backup/settings-groups.ts`), so a preference added
 * later inherits its group's answer rather than needing a second list kept in step by hand.
 *
 * Everything in this module is pure and side-effect free; `settings-sync-runtime.ts` owns the
 * stores, the database and the ordering.
 */
import type { SettingRow, SettingUpsert } from '@/db/repositories/types/settings';
import {
  isLiveSyncableGroup,
  ownerOfStoreField,
  LIVE_SYNCED_STORE_KEYS,
  LIVE_SYNCABLE_SETTINGS_GROUP_IDS,
  SETTINGS_GROUP_IDS,
  type SettingsGroupSelection,
} from '@/features/backup/settings-groups';
import { isPlainObject } from '@/lib/persisted-state';

/**
 * Separator between a row id's store key and field name.
 *
 * `#` cannot appear in a `gubbins:`-namespaced store key, so `<store key>#<field>` is unambiguous
 * as an *identity*. It is not reliably reversible — nothing stops a future field name containing a
 * `#` — which is why the row carries `store_key` and `field` as their own columns rather than
 * re-splitting the id on every read.
 */
export const SETTING_ID_SEPARATOR = '#';

/**
 * The row id for one preference — **derived**, not random, so the same preference is the same row
 * on every device and Last-Write-Wins resolves the two values against each other.
 */
export function settingRowId(storeKey: string, field: string): string {
  return `${storeKey}${SETTING_ID_SEPARATOR}${field}`;
}

/** The live persisted state of each participating store, keyed by its `localStorage` key. */
export type SettingsStoreStates = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Which groups this device shares live, keyed by group id (absent/false ⇒ not shared). */
export type LiveSettingsSelection = Readonly<Record<string, boolean>>;

/**
 * The shipped per-group selection: every eligible group ticked, the ineligible ones off.
 *
 * This is not "on by default" — {@link resolveLiveSettingsSelection} returns nothing at all until
 * the user turns settings sync on. It is what they get *when* they do, and everything-ticked is the
 * right starting point because switching the feature on is a request to share settings; the picker
 * is there to narrow it afterwards.
 */
export const DEFAULT_LIVE_SETTINGS_SELECTION: SettingsGroupSelection = Object.freeze(
  Object.fromEntries(SETTINGS_GROUP_IDS.map((id) => [id, isLiveSyncableGroup(id)])) as SettingsGroupSelection,
);

/**
 * Narrow an arbitrary persisted value to a selection of real groups, with the ineligible ones forced
 * off — the reconcile-on-read guard for a preference stored as a free-form object. A value that
 * isn't an object at all falls back to the shipped default; unknown keys are dropped.
 *
 * Forcing rather than merely dropping the ineligible groups is what lets the result be a complete
 * {@link SettingsGroupSelection}, which is what the shared picker takes. Eligibility is still
 * re-checked when it matters ({@link isSharedSettingField}), so a hand-edited store cannot widen
 * what travels by writing `device: true` here.
 */
export function normaliseLiveSettingsSelection(value: unknown): SettingsGroupSelection {
  if (!isPlainObject(value)) return DEFAULT_LIVE_SETTINGS_SELECTION;
  return Object.fromEntries(
    SETTINGS_GROUP_IDS.map((id) => [id, isLiveSyncableGroup(id) && value[id] === true]),
  ) as SettingsGroupSelection;
}

/**
 * The groups this device actually shares, having applied both gates: the master opt-in and the
 * per-group ticks. Ineligible groups (`device`) can never appear however the persisted selection
 * reads, and an unknown group id from an older or newer build is dropped rather than trusted.
 *
 * Returns an empty selection when settings sync is off — which is the shipped default, and is what
 * makes the whole feature cost nothing (no rows read, none written) until the user asks for it.
 */
export function resolveLiveSettingsSelection(
  enabled: boolean,
  groups: LiveSettingsSelection,
): LiveSettingsSelection {
  if (!enabled) return {};
  const resolved: Record<string, boolean> = {};
  for (const id of LIVE_SYNCABLE_SETTINGS_GROUP_IDS) {
    if (groups[id] === true) resolved[id] = true;
  }
  return resolved;
}

/** Whether one store field may travel live *and* this device has opted its group in. */
export function isSharedSettingField(
  storeKey: string,
  field: string,
  selection: LiveSettingsSelection,
): boolean {
  if (!LIVE_SYNCED_STORE_KEYS.includes(storeKey)) return false;
  const owner = ownerOfStoreField(storeKey, field);
  // An ungrouped field is one the registry does not describe — a preference added by a newer build,
  // or a hand-edited key. Never publish it: no picker could have offered it, so no user agreed to
  // share it. The registry's own drift test is what keeps this from silently swallowing new
  // preferences (it fails the build until a group claims them).
  return owner !== undefined && isLiveSyncableGroup(owner) && selection[owner] === true;
}

/**
 * JSON-encode one preference value for storage, or null when it cannot travel.
 *
 * Functions (a Zustand store's actions sit in the same object as its state) and `undefined` are
 * skipped rather than encoded. A non-finite number is skipped too: `JSON.stringify` turns `NaN`
 * into `null`, which would land as a *type change* on the far side rather than a lost value.
 */
export function encodeSettingValue(value: unknown): string | null {
  if (typeof value === 'function' || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  try {
    const json = JSON.stringify(value);
    return json ?? null;
  } catch {
    // A cyclic or non-serialisable value: nothing sane to publish, and throwing here would fail
    // the whole sync over one preference.
    return null;
  }
}

/** Decode a stored value. `ok: false` for anything that isn't readable JSON (a damaged row). */
export function decodeSettingValue(json: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether an incoming value is shaped like the one the store currently holds.
 *
 * A row's value comes from another device — possibly running a different build, possibly restored
 * from a hand-edited file — so it is untrusted in exactly the way a restored backup's settings blob
 * is untrusted, and it gets the same standard of care: the *shape* is checked here, and the
 * *range* is left to the clamping and `normalise*` helpers the stores already apply on read. That
 * is deliberate rather than lazy — those helpers are the single place range rules live, and
 * duplicating ~70 of them here would create a second copy to drift.
 *
 * `reference` is the value the store holds right now, which is always a valid one (it came from the
 * shipped default or from a normalising setter), so it doubles as the shape to expect. Recursion is
 * bounded by *its* depth, never the candidate's: structure is only descended into where the
 * reference has structure, so a deeply-nested payload cannot drive this into a stack overflow.
 */
export function sameSettingShape(candidate: unknown, reference: unknown): boolean {
  // Nothing to compare against (a nullable preference currently sitting at null): accept any
  // readable JSON value and let the read-side normalisers have the last word, as they already do
  // for the same value arriving in a restored backup.
  if (reference === null || reference === undefined) return true;
  if (candidate === null || candidate === undefined) return false;

  if (Array.isArray(reference)) {
    if (!Array.isArray(candidate)) return false;
    const element = reference[0];
    if (element === undefined) return true; // an empty default says nothing about its elements
    return candidate.every((entry) => sameSettingShape(entry, element));
  }

  if (isPlainObject(reference)) {
    if (!isPlainObject(candidate)) return false;
    // Only keys the reference describes are checked. A key it doesn't have may be a preference from
    // a newer build (keep it — dropping it would silently downgrade the peer's setting), and a key
    // it has but the candidate lacks may be one from an older build (the store's own merge fills
    // the gap from its defaults).
    return Object.entries(candidate).every(
      ([key, value]) => !(key in reference) || sameSettingShape(value, reference[key]),
    );
  }

  if (typeof candidate !== typeof reference) return false;
  if (typeof candidate === 'number' && !Number.isFinite(candidate)) return false;
  return true;
}

/**
 * What to publish to the shared noticeboard — one upsert per eligible preference whose stored row
 * is missing or holds a different value.
 *
 * Only *differences* are written, and that is load-bearing rather than an optimisation: the
 * `updated_at` trigger stamps any UPDATE, so re-writing an unchanged value would make this device
 * look strictly newer than a peer that had in fact just changed the preference, and the two would
 * push the row back and forth forever (the churn issue #161 fixed for the merge path — the same
 * trap, reached from the write side).
 *
 * `limitTo` narrows to specific row ids for the common case of "the user just changed one thing";
 * omit it to reconcile every eligible preference, which is what enabling a group does.
 */
export function planSettingPublishes(
  states: SettingsStoreStates,
  selection: LiveSettingsSelection,
  existing: readonly SettingRow[],
  limitTo?: readonly string[],
): SettingUpsert[] {
  const stored = new Map(existing.map((row) => [row.id, row.value]));
  const wanted = limitTo === undefined ? undefined : new Set(limitTo);
  const upserts: SettingUpsert[] = [];

  for (const storeKey of LIVE_SYNCED_STORE_KEYS) {
    const state = states[storeKey];
    if (!state) continue;
    for (const [field, value] of Object.entries(state)) {
      const id = settingRowId(storeKey, field);
      if (wanted && !wanted.has(id)) continue;
      if (!isSharedSettingField(storeKey, field, selection)) continue;
      const encoded = encodeSettingValue(value);
      if (encoded === null || stored.get(id) === encoded) continue;
      upserts.push({ storeKey, field, value: encoded });
    }
  }

  return upserts;
}

/** The per-store patches to write into the Zustand stores, plus what was refused and why. */
export interface SettingApplyPlan {
  /** Store key → the field/value patch to merge into that store. Only stores with changes appear. */
  readonly patches: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Row ids dropped because the value was unreadable or not shaped like the store's own. */
  readonly rejected: readonly string[];
}

/**
 * What to adopt from the shared noticeboard — every row whose group this device shares and whose
 * value differs from what the store holds, having passed the shape check.
 *
 * A row for an unshared group, an unknown store or an ungrouped field is ignored, not applied:
 * receiving is gated by the same per-group opt-in as publishing, so a device that shares only its
 * appearance never has its scanner settings rewritten by the desktop.
 */
export function planSettingApplies(
  rows: readonly SettingRow[],
  states: SettingsStoreStates,
  selection: LiveSettingsSelection,
): SettingApplyPlan {
  const patches: Record<string, Record<string, unknown>> = {};
  const rejected: string[] = [];

  for (const row of rows) {
    if (!isSharedSettingField(row.store_key, row.field, selection)) continue;
    const state = states[row.store_key];
    if (!state) continue;

    const decoded = decodeSettingValue(row.value);
    if (!decoded.ok || !sameSettingShape(decoded.value, state[row.field])) {
      rejected.push(row.id);
      continue;
    }
    // Comparing encodings rather than the values themselves: it is the comparison the publish side
    // makes, so "already applied" means the same thing on both, and it settles deep equality for
    // the object-valued preferences (card fields, hotkey bindings) without a bespoke walk.
    if (encodeSettingValue(state[row.field]) === row.value) continue;

    (patches[row.store_key] ??= {})[row.field] = decoded.value;
  }

  return { patches, rejected };
}
