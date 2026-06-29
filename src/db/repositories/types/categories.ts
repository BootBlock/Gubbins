/**
 * Category + custom-field row/DTO types (spec §4 "Categories & Schema Evolution").
 */
import type { FieldType } from '../constants';

// --- Categories (Phase 2 minimal stub; schemas/custom fields are Phase 3) --------

export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly updated_at: number;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

/** A category plus its custom-field count, for the management list. */
export interface CategoryWithFieldCount extends Category {
  readonly fieldCount: number;
}

export interface CreateCategoryInput {
  readonly name: string;
}

export interface UpdateCategoryInput {
  readonly name?: string;
}

// --- Category custom fields (spec §4 "Categories & Schema Evolution") -----------

export interface CategoryFieldRow {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly field_type: FieldType;
  readonly options: string | null;
  readonly is_required: number;
  readonly default_value: string | null;
  readonly position: number;
  readonly updated_at: number;
}

export interface CategoryField {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly fieldType: FieldType;
  /** Choice list for `SELECT` fields; null otherwise. */
  readonly options: string[] | null;
  readonly isRequired: boolean;
  /** Value applied by lenient defaulting when an item has no stored value. */
  readonly defaultValue: string | null;
  readonly position: number;
  readonly updatedAt: number;
}

export interface CreateCategoryFieldInput {
  readonly name: string;
  readonly fieldType: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  readonly position?: number;
}

export interface UpdateCategoryFieldInput {
  readonly name?: string;
  readonly fieldType?: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  readonly position?: number;
}

/**
 * A category field resolved against a specific item's stored value, applying
 * **lenient defaulting** (spec §4): when no value row exists the field's
 * `defaultValue` (or null) is returned silently — no migration of existing rows.
 */
export interface ResolvedItemField extends CategoryField {
  /** The item's stored value, the field default, or null (lenient defaulting). */
  readonly value: string | null;
  /** True when the value came from a stored row rather than the default. */
  readonly hasStoredValue: boolean;
}
