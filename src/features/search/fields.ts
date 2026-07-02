/**
 * Field & operator metadata for the Visual Builder (spec §5.1). British-English
 * labels live here, kept out of the SQL-generation layer ({@link parseASTtoSQL},
 * which only knows raw field identifiers). The builder exposes the fields that map
 * cleanly to a text/number/capability input; id-keyed fields the parser also
 * supports (category, location) are deliberately omitted until there's a picker UI.
 */
import type { FilterOperator } from '@/db/search/ast';

export type BuilderFieldKind = 'text' | 'number' | 'capability' | 'customfield';

export interface BuilderField {
  /** The AST field identifier (for capability this is just the marker `capability`). */
  readonly value: string;
  readonly label: string;
  readonly kind: BuilderFieldKind;
}

export const BUILDER_FIELDS: readonly BuilderField[] = [
  { value: 'name', label: 'Name', kind: 'text' },
  { value: 'description', label: 'Description', kind: 'text' },
  { value: 'notes', label: 'Notes', kind: 'text' },
  { value: 'mpn', label: 'MPN', kind: 'text' },
  { value: 'manufacturer', label: 'Manufacturer', kind: 'text' },
  { value: 'quantity', label: 'Quantity', kind: 'number' },
  { value: 'capability', label: 'Capability', kind: 'capability' },
  { value: 'customfield', label: 'Custom field', kind: 'customfield' },
];

export const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = {
  EQUALS: 'equals',
  CONTAINS: 'contains',
  GREATER_THAN: 'greater than',
  LESS_THAN: 'less than',
  HAS_CAPABILITY: 'has capability',
};

/**
 * The display label for an operator within a given field kind. Identical to
 * {@link OPERATOR_LABELS} except `HAS_CAPABILITY` — reused as the generic "presence"
 * operator — reads as "has any value" on a custom field, where "has capability" would
 * be misleading.
 */
export function operatorLabelFor(operator: FilterOperator, kind: BuilderFieldKind): string {
  if (operator === 'HAS_CAPABILITY' && kind === 'customfield') return 'has any value';
  return OPERATOR_LABELS[operator];
}

/** The operators offered for a given field kind, in display order. */
export function operatorsForKind(kind: BuilderFieldKind): FilterOperator[] {
  switch (kind) {
    case 'text':
      return ['CONTAINS', 'EQUALS'];
    case 'number':
      return ['GREATER_THAN', 'LESS_THAN', 'EQUALS'];
    case 'capability':
      return ['HAS_CAPABILITY', 'EQUALS', 'GREATER_THAN', 'LESS_THAN'];
    case 'customfield':
      return ['CONTAINS', 'EQUALS', 'GREATER_THAN', 'LESS_THAN', 'HAS_CAPABILITY'];
  }
}

const CAPABILITY_PREFIX = 'capability:';
const CUSTOM_FIELD_PREFIX = 'field:';

/** True when an AST field is a `capability:<key>` reference. */
export function isCapabilityField(field: string): boolean {
  return field.toLowerCase().startsWith(CAPABILITY_PREFIX);
}

/** Extract the key from a `capability:<key>` field (empty string when absent). */
export function capabilityKey(field: string): string {
  return isCapabilityField(field) ? field.slice(CAPABILITY_PREFIX.length) : '';
}

/** Compose a `capability:<key>` field identifier from a key. */
export function toCapabilityField(key: string): string {
  return `${CAPABILITY_PREFIX}${key.trim()}`;
}

/** True when an AST field is a `field:<name>` custom-field reference (Phase 71). */
export function isCustomField(field: string): boolean {
  return field.toLowerCase().startsWith(CUSTOM_FIELD_PREFIX);
}

/** Extract the name from a `field:<name>` custom-field reference (empty when absent). */
export function customFieldName(field: string): string {
  return isCustomField(field) ? field.slice(CUSTOM_FIELD_PREFIX.length) : '';
}

/** Compose a `field:<name>` custom-field identifier from a field name. */
export function toCustomField(name: string): string {
  return `${CUSTOM_FIELD_PREFIX}${name.trim()}`;
}

/** The dropdown value representing a condition's field (`capability`/`customfield` for those forms). */
export function fieldSelectValue(field: string): string {
  if (isCapabilityField(field)) return 'capability';
  if (isCustomField(field)) return 'customfield';
  return field;
}

/** The field kind for an AST field identifier. */
export function kindOfField(field: string): BuilderFieldKind {
  if (isCapabilityField(field)) return 'capability';
  if (isCustomField(field)) return 'customfield';
  return BUILDER_FIELDS.find((f) => f.value === field)?.kind ?? 'text';
}
