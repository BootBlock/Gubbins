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
 * The allow-list and scrubbing are pure (testable with a plain record); only
 * {@link collectSettings} / {@link applySettings} touch `localStorage`.
 */

/** The only `localStorage` keys a backup may carry (everything else, incl. auth/tokens, is excluded). */
export const EXPORTABLE_SETTING_KEYS = [
  'gubbins:preferences', // theme, units, density, currency, bridge URL (token scrubbed)
  'gubbins:layout', // dashboard widget layout
  'gubbins:saved-searches', // saved search queries
] as const;

const EXPORTABLE_SET: ReadonlySet<string> = new Set(EXPORTABLE_SETTING_KEYS);

/** State fields scrubbed from a persisted store blob before it enters a backup (secrets). */
const SCRUBBED_STATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'gubbins:preferences': ['bridgeToken'],
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

/** Read the allow-listed, scrubbed settings from storage (defaults to `localStorage`). */
export function collectSettings(storage: Storage = localStorage): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of EXPORTABLE_SETTING_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) raw[key] = value;
  }
  return sanitiseSettingsRecord(raw);
}

/**
 * Write restored settings back into storage. Only allow-listed keys are written (the record
 * is re-sanitised first), so a malformed backup can never clobber an arbitrary key. Returns
 * the number of keys written. A reload is required for the stores to re-hydrate.
 */
export function applySettings(record: Record<string, string>, storage: Storage = localStorage): number {
  const clean = sanitiseSettingsRecord(record);
  let written = 0;
  for (const [key, value] of Object.entries(clean)) {
    if (!EXPORTABLE_SET.has(key)) continue;
    storage.setItem(key, value);
    written += 1;
  }
  return written;
}
