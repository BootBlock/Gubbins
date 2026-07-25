/**
 * Shared-settings row types (issue #382 — preferences that travel live between devices).
 *
 * One row per (persisted store, preference field). Unlike every other table here the `id` is
 * **derived** from those two columns rather than a random UUID, so the same preference carries the
 * same row id on every device and Last-Write-Wins can resolve one device's value against another's.
 * The pure `features/settings/settings-sync.ts` seam owns that derivation and the encoding of
 * `value`; this module only describes the shape the driver returns.
 */

export interface SettingRow {
  /** `<store key>#<field>`, e.g. `gubbins:preferences#mode` — see `settingRowId`. */
  readonly id: string;
  /** The persisted store the preference belongs to, e.g. `gubbins:preferences`. */
  readonly store_key: string;
  /** The preference's field name inside that store's persisted state, e.g. `mode`. */
  readonly field: string;
  /** JSON encoding of the preference's value. Untrusted on the way in — validate before applying. */
  readonly value: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** One preference to publish to the shared noticeboard: its identity plus its encoded value. */
export interface SettingUpsert {
  readonly storeKey: string;
  readonly field: string;
  /** JSON encoding of the value, as produced by `encodeSettingValue`. */
  readonly value: string;
}
