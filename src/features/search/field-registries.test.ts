import { describe, expect, it } from 'vitest';
import { ITEM_FIELD_KINDS, TAG_FIELD, type ItemFieldKind } from '@/db/search/parseASTtoSQL';
import { BUILDER_FIELDS, type BuilderFieldKind } from './fields';
import { FIELD_ALIASES, type TextQueryFieldKind } from './parse-text-query';

/**
 * The searchable-item vocabulary is stated three times, once per layer, in the terms that
 * layer needs: `ITEM_FIELDS` (column + comparison kind), `FIELD_ALIASES` (the spellings a
 * typed query accepts) and `BUILDER_FIELDS` (label + input control). Nothing related them,
 * so a field added to one and forgotten in the others failed *silently* — `notes:foo` would
 * fall back to a plain text search, and a perfectly valid saved query would be invisible in
 * the Visual Builder (issue #247).
 *
 * That is the same failure the bridge's OData property map already hit once (issue #143), so
 * the guard is the same shape: the three lists may only be extended together.
 */

/**
 * How each `id-text` field — a foreign-key column whose value is an opaque id — is offered
 * by the layers above the SQL translator.
 *
 * These are named rather than skipped by kind, so adding a new id-keyed field forces the same
 * decision to be made for it instead of it dropping out of the checks below unnoticed.
 *
 * - No typed-query alias: nobody searches by typing a raw id, so there is no spelling for one.
 * - `presence` in the Builder, or nothing: with no id picker the Builder can only ask whether
 *   the field is set, which negated answers "anything without a category" (issue #139).
 */
const ID_TEXT_SURFACES: Readonly<Record<string, { readonly builder: BuilderFieldKind | null }>> = {
  category: { builder: 'presence' },
  location: { builder: null },
};

/** The alias table's kind for each comparison kind `ITEM_FIELDS` declares. */
const ALIAS_KIND_FOR: Readonly<Record<Exclude<ItemFieldKind, 'id-text'>, TextQueryFieldKind>> = {
  'fts-text': 'text',
  numeric: 'numeric',
  boolean: 'boolean',
  enum: 'enum',
  money: 'money',
  'date-ms': 'date',
  'date-text': 'date',
};

/** The Builder control for each comparison kind `ITEM_FIELDS` declares. */
const BUILDER_KIND_FOR: Readonly<Record<Exclude<ItemFieldKind, 'id-text'>, BuilderFieldKind>> = {
  'fts-text': 'text',
  numeric: 'number',
  boolean: 'boolean',
  enum: 'enum',
  // Money is entered in the base currency's major units, so it uses the number control.
  money: 'number',
  'date-ms': 'date',
  'date-text': 'date',
};

/** Builder entries that are markers for a whole family of fields, not scalar item columns. */
const BUILDER_MARKERS: readonly string[] = ['capability', 'customfield'];

const builderByValue = new Map(BUILDER_FIELDS.map((field) => [field.value, field]));

/** Narrows away the id-keyed kinds, which the two kind maps above deliberately omit. */
function isScalarKind(kind: ItemFieldKind): kind is Exclude<ItemFieldKind, 'id-text'> {
  return kind !== 'id-text';
}

const scalarFields = Object.entries(ITEM_FIELD_KINDS).flatMap(([field, kind]) =>
  isScalarKind(kind) ? [[field, kind] as const] : [],
);

const idTextFields = Object.entries(ITEM_FIELD_KINDS)
  .filter(([, kind]) => kind === 'id-text')
  .map(([field]) => field);

describe('the three searchable-field registries agree (issue #247)', () => {
  it('has a decision recorded for every id-keyed field', () => {
    expect(idTextFields.sort()).toEqual(Object.keys(ID_TEXT_SURFACES).sort());
  });

  it('gives every scalar field at least one typed-query spelling', () => {
    for (const [field] of scalarFields) {
      const aliases = Object.entries(FIELD_ALIASES).filter(([, target]) => target.field === field);
      expect(aliases.length, `no FIELD_ALIASES entry reaches "${field}"`).toBeGreaterThan(0);
    }
  });

  it('gives every alias the kind its field is compared with', () => {
    for (const [field, kind] of scalarFields) {
      for (const [alias, target] of Object.entries(FIELD_ALIASES)) {
        if (target.field !== field) continue;
        expect(target.kind, `alias "${alias}" disagrees with ITEM_FIELDS`).toBe(ALIAS_KIND_FOR[kind]);
      }
    }
  });

  it('offers every scalar field in the Visual Builder, with the matching control', () => {
    for (const [field, kind] of scalarFields) {
      const entry = builderByValue.get(field);
      expect(entry, `no BUILDER_FIELDS entry for "${field}"`).toBeDefined();
      expect(entry?.kind, `builder control for "${field}" disagrees with ITEM_FIELDS`).toBe(
        BUILDER_KIND_FOR[kind],
      );
    }
  });

  it('offers each id-keyed field exactly as its recorded decision says', () => {
    for (const [field, surfaces] of Object.entries(ID_TEXT_SURFACES)) {
      const aliases = Object.entries(FIELD_ALIASES).filter(([, target]) => target.field === field);
      expect(aliases, `"${field}" is an opaque id, so it should have no spelling`).toEqual([]);
      expect(builderByValue.get(field)?.kind ?? null).toBe(surfaces.builder);
    }
  });

  it('names no field the SQL translator cannot resolve', () => {
    const known = new Set([...Object.keys(ITEM_FIELD_KINDS), TAG_FIELD]);
    for (const [alias, target] of Object.entries(FIELD_ALIASES)) {
      expect([...known], `alias "${alias}" points at an unknown field`).toContain(target.field);
    }
    for (const entry of BUILDER_FIELDS) {
      if (BUILDER_MARKERS.includes(entry.value)) continue;
      expect([...known], `builder field "${entry.value}" is unknown`).toContain(entry.value);
    }
  });

  it('treats a tag as a text field on both surfaces', () => {
    // `tag` is a valid AST field but lives outside ITEM_FIELDS — it lowers to an EXISTS over
    // the item↔tag join, not a column — so it is checked explicitly rather than assumed.
    const aliases = Object.entries(FIELD_ALIASES).filter(([, t]) => t.field === TAG_FIELD);
    expect(aliases.length).toBeGreaterThan(0);
    for (const [, target] of aliases) expect(target.kind).toBe('text');
    expect(builderByValue.get(TAG_FIELD)?.kind).toBe('text');
  });

  it('lists each Builder field once', () => {
    expect(builderByValue.size).toBe(BUILDER_FIELDS.length);
  });
});
