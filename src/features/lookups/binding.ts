/**
 * Binding a provider's output keys to a category's actual fields (issue #616, phase L0).
 *
 * This is the part of the feature with no existing precedent: a provider knows it can supply a
 * director's name, but it cannot know that *this* category calls that field `Director`, or
 * `Regisseur`, or nothing at all. Binding resolves that in two layers, so the common case is
 * zero-config and the awkward case is still fixable:
 *
 * 1. **By name, at run time.** Each output key's `defaultTarget` is matched against the
 *    category's field names through `lib/name-fold` — the same fold the field dictionary itself
 *    uses, so "Director" and "director" are one name here exactly as they are there. Provider
 *    defaults are lifted verbatim from the preset they serve, so an untouched preset category
 *    binds every key with no configuration at all.
 * 2. **By an explicit stored map**, when the user has renamed or re-purposed a field. The
 *    category's `fieldMap` (output key → `category_fields.id`, or a `builtin:` target) wins over
 *    the name match.
 *
 * **Nothing is ever silently dropped.** An output key that binds to no field, or that binds to a
 * field of the wrong type, is *reported* — the same rule the import pipeline follows (#350:
 * readers report why a value is unusable rather than substituting something). A `NUMBER` release
 * year landing in a `TEXT` field is a mismatch the user should see and fix, not a value quietly
 * stringified into place, and an unbound key is an offer to add the field rather than a value
 * that vanishes.
 *
 * Pure and DB-free: the caller passes the category's resolved fields in, so this is exhaustively
 * unit-testable with no database at all.
 */
import type { FieldType } from '@/db/repositories';
import { foldName } from '@/lib/name-fold';
import { isBuiltinLookupTarget, type BuiltinLookupTarget, type LookupOutputDef } from './types';

/**
 * The minimum a field must expose to be bindable: its identity, its type, and its name.
 *
 * Narrower than `CategoryField` deliberately, so the seam can be driven from a plain object in
 * a test and does not force a caller to fabricate the category-local half of a real field.
 */
export interface BindableField {
  /** The `category_fields.id` — the category's *use* of the field, which is what a map stores. */
  readonly id: string;
  readonly name: string;
  /** The field's declared type, compared against the output key's. */
  readonly fieldType: FieldType;
  /** Choice list for a `SELECT` field; null otherwise. Carried so a value can be validated. */
  readonly options: string[] | null;
}

/** Where a bound output key's value will land. */
export type LookupTarget =
  /** One of the item's category's custom fields. */
  | { readonly kind: 'field'; readonly field: BindableField }
  /** A reserved built-in item attribute. */
  | { readonly kind: 'builtin'; readonly target: BuiltinLookupTarget };

/**
 * An output key that will not be filled, and the reason — surfaced, never swallowed.
 *
 * A discriminated union rather than one shape with a nullable `foundType`, so the renderer that
 * names the wrong type back to the user cannot be written without the compiler proving there *is*
 * one: a `NO_FIELD` problem has no found type at all, and a fallback there would invent one.
 */
export type LookupBindingProblem =
  | {
      /** No field of the category matches the key's target, by map or by name. */
      readonly kind: 'NO_FIELD';
      readonly outputKey: string;
      /** The field name the key was looking for — the provider's default. */
      readonly wantedName: string;
      /** The type the provider produces for this key. */
      readonly wantedType: FieldType;
    }
  | {
      /** A field was found, but its type is not the one the key produces. */
      readonly kind: 'TYPE_MISMATCH';
      readonly outputKey: string;
      /**
       * The **found** field's own name, not the provider's default: when a map points at "Notes"
       * for the release year, "Notes is text, not a number" is the actionable sentence, and
       * "Release year" would name a field that isn't the problem.
       */
      readonly wantedName: string;
      readonly wantedType: FieldType;
      /** The type that field actually has. */
      readonly foundType: FieldType;
    };

/** One output key successfully bound to a place its value can land. */
export interface LookupBinding {
  readonly outputKey: string;
  readonly target: LookupTarget;
  /** The name to show for this binding — the field's own name, or the built-in's target id. */
  readonly targetName: string;
}

/** Every output key resolved: what will be filled, and what will not (with the reason). */
export interface LookupBindingSet {
  readonly bindings: readonly LookupBinding[];
  readonly problems: readonly LookupBindingProblem[];
}

/**
 * Resolve every one of a provider's output keys against a category's fields.
 *
 * `fieldMap` is the category's stored override (output key → `category_fields.id` or a
 * `builtin:` target); pass null when it has none. A map entry pointing at a field the category
 * no longer has falls back to the name match rather than failing outright — a field can be
 * removed long after the map was written, and the name is the more durable of the two.
 */
export function bindLookupOutputs(
  outputs: readonly LookupOutputDef[],
  fields: readonly BindableField[],
  fieldMap: Readonly<Record<string, string>> | null,
): LookupBindingSet {
  const byId = new Map(fields.map((f) => [f.id, f]));
  // Folded once per call rather than per output key. First occurrence wins, matching
  // `findFieldDefByName`'s stable ordering: a database written before the fold existed can hold
  // two names that fold together, and which one a lookup binds to must not vary run to run.
  const byFoldedName = new Map<string, BindableField>();
  for (const field of fields) {
    const key = foldName(field.name);
    if (!byFoldedName.has(key)) byFoldedName.set(key, field);
  }

  const bindings: LookupBinding[] = [];
  const problems: LookupBindingProblem[] = [];

  for (const output of outputs) {
    const mapped = fieldMap?.[output.key];

    // An explicit map entry naming a built-in is authoritative — a built-in cannot be
    // "missing", so there is nothing to fall back to and nothing to type-check against.
    if (mapped !== undefined && isBuiltinLookupTarget(mapped)) {
      bindings.push({
        outputKey: output.key,
        target: { kind: 'builtin', target: mapped },
        targetName: mapped,
      });
      continue;
    }

    const field =
      (mapped === undefined ? undefined : byId.get(mapped)) ??
      byFoldedName.get(foldName(output.defaultTarget));

    // The provider's own default may address a built-in directly (`builtin:name`), in which case
    // there is no field name to match. Tested *after* the map lookup, so an override still wins,
    // but *before* the not-found report, so a map entry pointing at a field the category no longer
    // has falls back to the built-in — the same fallback a name-targeted key gets. Without that
    // ordering a stale map entry would permanently lose a target that cannot itself go missing,
    // and report it as "there's no `builtin:name` field", which is not a sentence to show anyone.
    if (field === undefined && isBuiltinLookupTarget(output.defaultTarget)) {
      bindings.push({
        outputKey: output.key,
        target: { kind: 'builtin', target: output.defaultTarget },
        targetName: output.defaultTarget,
      });
      continue;
    }

    if (field === undefined) {
      problems.push({
        kind: 'NO_FIELD',
        outputKey: output.key,
        wantedName: output.defaultTarget,
        wantedType: output.type,
      });
      continue;
    }
    if (field.fieldType !== output.type) {
      problems.push({
        kind: 'TYPE_MISMATCH',
        outputKey: output.key,
        wantedName: field.name,
        wantedType: output.type,
        foundType: field.fieldType,
      });
      continue;
    }
    bindings.push({ outputKey: output.key, target: { kind: 'field', field }, targetName: field.name });
  }

  return { bindings, problems };
}
