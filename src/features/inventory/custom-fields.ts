/**
 * Pure validation/coercion seam for per-item **custom-field values** (spec §4
 * "Categories & Schema Evolution"). Custom-field *templates* already ship as
 * `category_fields` (definitions) + `item_field_values` (EAV values, persisted as
 * TEXT in a STRICT table); this seam makes a value **typed-valid at the point of
 * save**, on those existing tables — the same path the CSV import (Phase 72)
 * validates through. No new tables, no second write path.
 *
 * Mirrors the sibling pure seams (`cycle-count.ts`, `asset-lifecycle.ts`,
 * `operational-metadata.ts`): pure, injectable, **no DB**, exhaustively unit-tested.
 * Anything time-related is injected via `opts.now` — there are no free
 * `Date.now()` / `new Date()` calls — so the seam is deterministic under test.
 */
import { assertExhaustive } from '@/lib/exhaustive';
import { isImageDataUrl } from '@/lib/image-data-url';
import type { CategoryField, FieldType } from '@/db/repositories';

/**
 * The minimum a value can be validated against: the definition's identity plus whether
 * it is required. Narrower than {@link CategoryField} on purpose, so the same seam
 * validates an item's value (where `isRequired` is the category's policy) and a
 * **location's** value (issue #97, where nothing is ever required) without either caller
 * having to fabricate the category-local half of a `CategoryField`.
 */
export interface ValidatableField {
  readonly name: string;
  readonly fieldType: FieldType;
  readonly options: string[] | null;
  readonly isRequired: boolean;
}

/**
 * The result of validating one raw field value against its definition. Never an
 * exception — callers branch on `ok`. On success `value` is the **storage string**
 * to persist (TEXT), or `null` to clear the value row (we never store `''`).
 */
export type FieldValidation =
  { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly error: string };

/** Options for {@link validateFieldValue}. `now` injects the clock for `DATE` work. */
export interface ValidateFieldOptions {
  /** Injected clock; unused today but reserved so DATE rules stay deterministic. */
  readonly now?: () => Date;
}

/**
 * Upper bound on an `IMAGE` field's stored bytes (the decoded size of its base64 `data:`
 * URL). The encoder (`encodeFieldImage`) caps dimensions and quality so a normal cover lands
 * far below this; the ceiling exists so a hand-crafted or imported value can't bloat the
 * **synced** database (the value rides `item_field_values`, which syncs and backs up).
 */
export const MAX_FIELD_IMAGE_BYTES = 512 * 1024;

/**
 * The decoded byte length of a base64 `data:` URL, computed from the base64 payload without
 * allocating the bytes: every 4 base64 chars encode 3 bytes, less one per `=` pad char.
 */
function base64DataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** True when a raw value is absent or whitespace-only (i.e. "clears the field"). */
function isBlank(raw: string | null | undefined): boolean {
  return raw === null || raw === undefined || raw.trim().length === 0;
}

/**
 * Validate and canonically coerce one raw custom-field value against its
 * definition. **Never throws.** Behaviour by `def.fieldType`:
 *
 * - **blank** (empty / whitespace-only) ⇒ if `isRequired` an error, else
 *   `{ ok: true, value: null }` (clears the stored row — never persists `''`).
 * - **TEXT** / **LONG_TEXT** ⇒ the trimmed string (LONG_TEXT keeps internal newlines).
 * - **URL** ⇒ must parse as an absolute `http:`/`https:` URL.
 * - **NUMBER** ⇒ must parse to a *finite* number and is re-serialised canonically
 *   via `String(n)` (so `'1.50'` → `'1.5'`, `'01'` → `'1'`); rejects `'1.2.3'`,
 *   `'abc'`, `'Infinity'`, `'NaN'`, blank-after-sign, etc.
 * - **RATING** ⇒ a whole number from 1 to 5.
 * - **BOOLEAN** / **ON_OFF** ⇒ normalised to `'true'` / `'false'` (case-insensitive
 *   in, plus the checkbox's own `'true'`/`'false'` output); anything else is
 *   rejected. The two types are identical here — `ON_OFF` is purely an alternate
 *   wording (see {@link FIELD_TYPES}).
 * - **DATE** ⇒ canonical ISO `YYYY-MM-DD`, validated as a *real* calendar date
 *   (rejects `'2026-13-40'`, `'2026-02-30'`, `'not-a-date'`).
 * - **SELECT** ⇒ must be one of `def.options ?? []`.
 * - **FILE** ⇒ any non-blank string (a path / UNC / `file://` / `http(s)` link),
 *   stored verbatim — a browser can't verify it points anywhere real.
 * - **IMAGE** ⇒ a bounded image `data:` URL (`data:image/…;base64,…`) within
 *   {@link MAX_FIELD_IMAGE_BYTES}; anything else is rejected.
 *
 * The returned `value` is always the string to persist (values are stored as TEXT).
 */
export function validateFieldValue(
  def: ValidatableField,
  raw: string | null | undefined,
  _opts: ValidateFieldOptions = {},
): FieldValidation {
  if (isBlank(raw)) {
    return def.isRequired ? { ok: false, error: `${def.name} is required.` } : { ok: true, value: null };
  }
  // Past the blank guard `raw` is a non-empty string.
  const text = (raw as string).trim();

  switch (def.fieldType) {
    case 'TEXT':
    case 'LONG_TEXT':
      return { ok: true, value: text };

    case 'URL': {
      try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: `${def.name} must be a valid http(s) URL.` };
        }
        return { ok: true, value: text };
      } catch {
        return { ok: false, error: `${def.name} must be a valid URL.` };
      }
    }

    case 'NUMBER': {
      // `Number('')` is 0 and `Number(' ')` is 0; the blank guard above already
      // excludes those. `Number('1.2.3')`/`Number('abc')` are NaN; ±Infinity is
      // non-finite — all rejected. Re-serialise via String(n) for a canonical form.
      const n = Number(text);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${def.name} must be a number.` };
      }
      return { ok: true, value: String(n) };
    }

    case 'RATING': {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return { ok: false, error: `${def.name} must be a whole number from 1 to 5.` };
      }
      return { ok: true, value: String(n) };
    }

    case 'BOOLEAN':
    case 'ON_OFF': {
      const lower = text.toLowerCase();
      if (lower === 'true') return { ok: true, value: 'true' };
      if (lower === 'false') return { ok: true, value: 'false' };
      return { ok: false, error: `${def.name} must be true or false.` };
    }

    case 'DATE': {
      const iso = canonicaliseIsoDate(text);
      if (iso === null) {
        return { ok: false, error: `${def.name} must be a valid date (YYYY-MM-DD).` };
      }
      return { ok: true, value: iso };
    }

    case 'SELECT': {
      const options = def.options ?? [];
      if (!options.includes(text)) {
        return {
          ok: false,
          error: `${def.name} must be one of: ${options.join(', ')}.`,
        };
      }
      return { ok: true, value: text };
    }

    case 'FILE':
      // A link to a file that lives outside the app — a local path, a UNC share, or a
      // `file://` / `http(s)` URI. We can't verify a local path from a browser, so any
      // non-blank string is accepted and stored verbatim (only the pointer travels).
      return { ok: true, value: text };

    case 'IMAGE': {
      // The control encodes a picked image to a bounded WebP `data:` URL before it ever
      // reaches here; this validates that shape and enforces the size cap so a hand-set
      // or imported value can't smuggle an oversized/non-image blob into the synced DB.
      if (!isImageDataUrl(text)) {
        return { ok: false, error: `${def.name} must be an image.` };
      }
      if (base64DataUrlByteLength(text) > MAX_FIELD_IMAGE_BYTES) {
        return { ok: false, error: `${def.name} image is too large.` };
      }
      return { ok: true, value: text };
    }

    default: {
      // Exhaustiveness guard: a new FieldType must extend this switch explicitly, or this
      // call stops compiling. The runtime fallback keeps the contract (never throws) for an
      // out-of-band value reaching us at runtime.
      assertExhaustive(def.fieldType);
      return { ok: false, error: `${def.name} has an unsupported field type.` };
    }
  }
}

/**
 * Parse `YYYY-MM-DD` into a canonical ISO date string, validating it is a *real*
 * calendar date (so `2026-02-30` / `2026-13-01` are rejected, not silently rolled
 * over). Returns null when the input is not a valid Gregorian date. We parse the
 * components by hand rather than via `new Date(str)` because the Date constructor
 * is lenient (it rolls overflow over) and timezone-sensitive.
 */
function canonicaliseIsoDate(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // Re-pad to the canonical zero-padded form (the regex already fixes width, but
  // this keeps the output construction explicit and obviously canonical).
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${match[1]}-${mm}-${dd}`;
}

/** Days in a given 1-based month, honouring Gregorian leap years. */
function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The custom-field definitions belonging to a category, in the repository's
 * display order (`ORDER BY position ASC, name COLLATE NOCASE ASC`).
 *
 * **Categories are flat** — there is no `parent_id` on `CategoryRow`, so there is
 * **no ancestor resolution**: a field belongs to exactly the one category it names
 * (flat model). This mirrors `CategoryRepository.listFields`'s ordering so the
 * editor and any CSV column mapping see fields in the same sequence the DB does.
 */
export function fieldsForCategory(defs: readonly CategoryField[], categoryId: string): CategoryField[] {
  return defs
    .filter((d) => d.categoryId === categoryId)
    .sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }),
    );
}
