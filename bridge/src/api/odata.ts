/**
 * A thin, dependency-free **OData-style query-option layer** for the item read endpoints.
 *
 * This is a *convenience subset* of the OData v4 URL conventions — **not** a compliant OData
 * service (no `$batch`, no `$apply`, no navigation-property semantics; a CSDL `$metadata`
 * document *is* served, by `odata-metadata.ts`). It exists purely so callers already fluent in
 * OData get familiar spellings that map 1:1 onto machinery the bridge already has:
 *
 *   - `$select`  → the `fields` sparse fieldset (see `field-select.ts`)
 *   - `$expand`  → the `include` field expansion
 *   - `$top`     → `limit`      · `$skip` → `offset`
 *   - `$orderby` → a whitelisted `ORDER BY` (this module)
 *   - `$filter`  → a constrained boolean filter compiled to the app's `SearchAST`
 *                  (see `odata-filter.ts`) — **never** bespoke SQL
 *
 * Each `$`-prefixed option is accepted as an *alias* of the plain REST name; when both are
 * present the OData spelling wins. Anything outside the supported subset is a `400` with a
 * message naming what *is* supported, so the boundary is explicit rather than silently wrong.
 */
import { ITEM_SORT_FIELDS, type ItemSort, type ItemSortField } from '@/db/repositories/item/sql.ts';
import { MAX_ORDERBY_TERMS } from './limits.ts';

/**
 * A malformed OData-style option (`$orderby`/`$filter`). The message is caller-facing and
 * PII-free (it only names the static option grammar/vocabulary), so it is safe to surface
 * verbatim as a `400 bad_request`.
 */
export class BadQueryError extends Error {}

/**
 * Read a query option by its OData `$name` first, then its plain REST `canonical` name. Returns
 * `null` when neither is present (so callers can distinguish "absent" from an empty value).
 */
export function readOption(url: URL, odataName: string, canonicalName: string): string | null {
  return url.searchParams.get(odataName) ?? url.searchParams.get(canonicalName);
}

/**
 * Parse an `$orderby` value (e.g. `"quantity desc,name"`) into a validated {@link ItemSort}
 * list. Each term is `<field> [asc|desc]`; the field must be in the sortable allow-list
 * (`ITEM_SORT_FIELDS`) and direction defaults to `asc`. Throws {@link BadQueryError} on an
 * unknown field, a bad direction, a malformed term, or too many terms.
 */
export function parseOrderBy(raw: string): readonly ItemSort[] {
  const terms = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) {
    throw new BadQueryError('"$orderby" must name at least one field.');
  }
  if (terms.length > MAX_ORDERBY_TERMS) {
    throw new BadQueryError(`Too many $orderby terms (max ${MAX_ORDERBY_TERMS}).`);
  }

  return terms.map((term) => {
    const parts = term.split(/\s+/);
    if (parts.length > 2) {
      throw new BadQueryError(`Malformed $orderby term "${term}" (expected "<field> [asc|desc]").`);
    }
    const [field, dirRaw] = parts as [string, string | undefined];
    if (!ITEM_SORT_FIELDS.includes(field as ItemSortField)) {
      throw new BadQueryError(`Cannot sort by "${field}". Sortable fields: ${ITEM_SORT_FIELDS.join(', ')}.`);
    }
    const direction = dirRaw === undefined ? 'asc' : dirRaw.toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') {
      throw new BadQueryError(`$orderby direction must be "asc" or "desc", got "${dirRaw}".`);
    }
    return { field: field as ItemSortField, direction };
  });
}
