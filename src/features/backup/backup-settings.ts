/**
 * Device-local settings capture for backups (the "App settings & preferences" toggle).
 *
 * Settings live in `localStorage` (Zustand-persist blobs), *outside* the database. A backup
 * can carry them so a fresh device restores the user's theme, units, dashboard layout and
 * saved searches — but only a curated **allow-list** of keys, and with secrets scrubbed:
 *
 *  - `gubbins:auth` and the Google OAuth token are deliberately **excluded** — they are
 *    device/session-specific and must never travel in a portable file.
 *  - the bridge **access token** inside `gubbins:preferences` is stripped, so a shared
 *    backup can't leak it (the non-secret bridge URL is kept).
 *
 * On top of the allow-list, the user chooses **which groups** of settings travel out and which
 * land on restore (issue #175) — the groups themselves, and all the splitting/merging logic, live
 * in `settings-groups.ts`. The allow-list and scrubbing are pure (testable with a plain record);
 * only {@link collectSettings} / {@link applySettings} touch `localStorage`.
 */
import {
  DEFAULT_SETTINGS_GROUPS,
  GROUPED_STORAGE_KEYS,
  NON_PORTABLE_PREF_FIELDS,
  PREFERENCES_KEY,
  filterSettingsByGroups,
  mergePreferencesBlob,
  type SettingsGroupSelection,
} from './settings-groups';

/**
 * The only `localStorage` keys a backup may carry (everything else, incl. auth/tokens, is
 * excluded). Derived from the group registry so a group and the allow-list can never disagree:
 * the preferences blob (split by field across groups) plus every whole-key group's keys.
 */
export const EXPORTABLE_SETTING_KEYS: readonly string[] = [PREFERENCES_KEY, ...GROUPED_STORAGE_KEYS];

const EXPORTABLE_SET: ReadonlySet<string> = new Set(EXPORTABLE_SETTING_KEYS);

/** State fields scrubbed from a persisted store blob before it enters a backup (secrets). */
const SCRUBBED_STATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [PREFERENCES_KEY]: NON_PORTABLE_PREF_FIELDS,
};

/**
 * Scrub a single persisted-store blob: drop the secret state fields for that key. Returns the
 * (possibly rewritten) JSON string, or null when the blob can't be parsed (so it's skipped
 * rather than exported raw). A key with no scrub rules passes through unchanged.
 */
function scrubSettingValue(key: string, raw: string): string | null {
  const scrub = SCRUBBED_STATE_FIELDS[key];
  if (!scrub) return raw;
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
      for (const field of scrub) delete parsed.state[field];
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/**
 * Reduce an arbitrary key → value record to the allow-listed, secret-scrubbed settings a
 * backup may contain. Pure. Used both when **building** a backup (from `localStorage`) and
 * when **reading** one (defence-in-depth: a hand-edited backup can never inject a foreign key).
 */
export function sanitiseSettingsRecord(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of EXPORTABLE_SETTING_KEYS) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const scrubbed = scrubSettingValue(key, value);
    if (scrubbed !== null) out[key] = scrubbed;
  }
  return out;
}

/**
 * Read the allow-listed, scrubbed settings from storage, narrowed to the chosen groups (defaults
 * to the shipped {@link DEFAULT_SETTINGS_GROUPS} — everything but the device-specific group).
 */
export function collectSettings(
  groups: SettingsGroupSelection = DEFAULT_SETTINGS_GROUPS,
  storage: Storage = localStorage,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of EXPORTABLE_SETTING_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) raw[key] = value;
  }
  return filterSettingsByGroups(sanitiseSettingsRecord(raw), groups);
}

/**
 * Write restored settings back into storage, narrowed to the groups the user chose to apply.
 * Only allow-listed keys are written (the record is re-sanitised first), so a malformed backup
 * can never clobber an arbitrary key, and the preferences blob is **merged over** the live one so
 * restoring one group never resets the settings in another. Returns the number of keys written.
 * A reload is required for the stores to re-hydrate.
 */
export function applySettings(
  record: Record<string, string>,
  groups: SettingsGroupSelection = DEFAULT_SETTINGS_GROUPS,
  storage: Storage = localStorage,
): number {
  const clean = filterSettingsByGroups(sanitiseSettingsRecord(record), groups);
  let written = 0;
  for (const [key, value] of Object.entries(clean)) {
    if (!EXPORTABLE_SET.has(key)) continue;
    storage.setItem(key, key === PREFERENCES_KEY ? mergePreferencesBlob(value, storage.getItem(key)) : value);
    written += 1;
  }
  return written;
}
