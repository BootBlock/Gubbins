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
import type { CategoryField } from '@/db/repositories';

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
 * - **TEXT** ⇒ the trimmed string.
 * - **NUMBER** ⇒ must parse to a *finite* number and is re-serialised canonically
 *   via `String(n)` (so `'1.50'` → `'1.5'`, `'01'` → `'1'`); rejects `'1.2.3'`,
 *   `'abc'`, `'Infinity'`, `'NaN'`, blank-after-sign, etc.
 * - **BOOLEAN** ⇒ normalised to `'true'` / `'false'` (case-insensitive in, plus
 *   the checkbox's own `'true'`/`'false'` output); anything else is rejected.
 * - **DATE** ⇒ canonical ISO `YYYY-MM-DD`, validated as a *real* calendar date
 *   (rejects `'2026-13-40'`, `'2026-02-30'`, `'not-a-date'`).
 * - **SELECT** ⇒ must be one of `def.options ?? []`.
 *
 * The returned `value` is always the string to persist (values are stored as TEXT).
 */
export function validateFieldValue(
  def: CategoryField,
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
      return { ok: true, value: text };

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

    case 'BOOLEAN': {
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

    default: {
      // Exhaustiveness guard: a new FieldType must extend this switch explicitly,
      // or this assignment stops compiling. The runtime fallback keeps the contract
      // (never throws) for an out-of-band value reaching us at runtime.
      const _never: never = def.fieldType;
      void _never;
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
