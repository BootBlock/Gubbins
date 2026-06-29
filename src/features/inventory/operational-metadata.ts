/**
 * Pure helpers for the §4.1.1 "flexible metadata layer for operational parameters"
 * (`items.operational_metadata`): a schema-less, per-item JSON object of arbitrary
 * operational values — the spec's own example being
 * `{ "bed_temp_celsius": 60, "extrusion_multiplier": 0.98, "drying_time_hrs": 4 }`.
 *
 * The editor works over an ordered list of `{ key, value }` rows; these helpers
 * convert that list to/from the normalised record the Repository persists. Values
 * arrive from text inputs as strings and are coerced to the natural primitive
 * (number / boolean / string) so the spec example stores `60` as a number, not the
 * string `"60"`. Validation is Zod-backed per §2.4.4 — no value is ever blindly
 * stored. (DB serialisation itself stays in the Repository, mirroring the existing
 * create path, to keep the db layer free of feature-layer imports.)
 */
import { z } from 'zod';

/** One editable parameter row in the UI (raw text, pre-coercion). */
export interface MetadataRow {
  readonly key: string;
  readonly value: string;
}

/** A stored operational value — a JSON primitive (string, finite number, boolean). */
const metadataValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

/** The §4.1.1 schema-less record, validated as a flat map of primitive values. */
export const operationalMetadataSchema = z.record(z.string(), metadataValueSchema);
export type OperationalMetadata = z.infer<typeof operationalMetadataSchema>;

export type BuildMetadataResult =
  | { readonly ok: true; readonly value: OperationalMetadata | null }
  | { readonly ok: false; readonly error: string };

/**
 * Coerce a raw text value to its natural primitive. A string is only treated as a
 * number when it round-trips exactly (`String(Number(x)) === x`), so leading/trailing
 * zeros, exponents and the like are preserved verbatim rather than silently altered.
 */
export function coerceMetadataValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (trimmed.length > 0) {
    const num = Number(trimmed);
    if (Number.isFinite(num) && String(num) === trimmed) return num;
  }
  return trimmed;
}

/**
 * Build the normalised record from editor rows. Blank rows (no key, no value) are
 * dropped; a value without a key, or a duplicate key (after trimming), is a typed
 * error the editor surfaces inline. An empty result yields `null` (stored as SQL
 * NULL — "no operational metadata"), never `{}`.
 */
export function buildMetadata(rows: readonly MetadataRow[]): BuildMetadataResult {
  const out: Record<string, string | number | boolean> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.trim().length === 0) continue; // a fully-blank row is ignored
      return { ok: false, error: 'Every parameter needs a name.' };
    }
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate parameter "${key}".` };
    }
    seen.add(key);
    out[key] = coerceMetadataValue(row.value);
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return { ok: true, value: null };
  const parsed = operationalMetadataSchema.safeParse(out);
  if (!parsed.success) return { ok: false, error: 'Parameters must be text, numbers or true/false.' };
  return { ok: true, value: parsed.data };
}

/**
 * Expand a stored record into editor rows. Primitive values become their string form;
 * a (rare, externally-authored) nested value is JSON-stringified so it is shown and
 * preserved rather than dropped. Insertion order is kept.
 */
export function metadataToRows(record: Record<string, unknown> | null | undefined): MetadataRow[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value),
  }));
}
