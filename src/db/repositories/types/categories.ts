/**
 * Category + custom-field row/DTO types (spec §4 "Categories & Schema Evolution").
 */
import type { Condition, FieldType, MaintenanceBasis, TrackingMode } from '../constants';

// --- Categories (Phase 2 minimal stub; schemas/custom fields are Phase 3) --------

export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  /** Optional decorative Unicode glyph/emoji (issue #83); null = none. */
  readonly glyph: string | null;
  /** Optional category-template default tracking mode (backlog T1); null = no default. */
  readonly default_tracking_mode: TrackingMode | null;
  /** Optional category-template default condition (backlog T2); null = no default. */
  readonly default_condition: Condition | null;
  /** Optional category-template default warranty window in whole months (backlog T2); null = none. */
  readonly default_warranty_months: number | null;
  /** Optional category-template default maintenance basis (backlog T2a); null = no schedule default. */
  readonly default_maintenance_basis: MaintenanceBasis | null;
  /** TIME interval in days for the default maintenance schedule (backlog T2a); null otherwise. */
  readonly default_maintenance_interval_days: number | null;
  /** USAGE interval in units for the default maintenance schedule (backlog T2a); null otherwise. */
  readonly default_maintenance_interval_usage: number | null;
  readonly updated_at: number;
}

export interface Category {
  readonly id: string;
  readonly name: string;
  /**
   * Optional decorative Unicode glyph/emoji (issue #83). When set, an item in this category
   * shows it as a faint greyscale watermark on its Visual card. Null when none is chosen.
   */
  readonly glyph: string | null;
  /**
   * Optional category-template default (backlog T1): soft-prefills a new item's tracking
   * mode in the create form. Null when the category carries no default.
   */
  readonly defaultTrackingMode: TrackingMode | null;
  /**
   * Optional category-template default (backlog T2): soft-prefills a new item's condition
   * on the create form's Lifecycle tab. Null when the category carries no default.
   */
  readonly defaultCondition: Condition | null;
  /**
   * Optional category-template default (backlog T2): a warranty *window* in whole months.
   * The create form soft-prefills its Warranty field with this and derives the expiry date
   * (acquired-on, else today, + N months) at submit. Null when the category carries no default.
   */
  readonly defaultWarrantyMonths: number | null;
  /**
   * Optional category-template default *maintenance schedule* (backlog T2a). Unlike the
   * soft-prefill facets above, this is **applied** after an item is created — the item
   * create paths add a matching `maintenance_schedules` row — rather than pre-filling a
   * create-form field. The application requires a non-null basis *and* its matching
   * interval; a basis without its interval is a no-op. Null basis = no schedule default.
   */
  readonly defaultMaintenanceBasis: MaintenanceBasis | null;
  /** TIME interval in days (backlog T2a); non-null only when the basis is TIME and set. */
  readonly defaultMaintenanceIntervalDays: number | null;
  /** USAGE interval in units (backlog T2a); non-null only when the basis is USAGE and set. */
  readonly defaultMaintenanceIntervalUsage: number | null;
  readonly updatedAt: number;
}

/** A category plus its custom-field count, for the management list. */
export interface CategoryWithFieldCount extends Category {
  readonly fieldCount: number;
}

export interface CreateCategoryInput {
  readonly name: string;
  /** Optional decorative Unicode glyph/emoji (issue #83); omit/null for none. */
  readonly glyph?: string | null;
  /** Category-template default tracking mode (backlog T1); omit/null for none. */
  readonly defaultTrackingMode?: TrackingMode | null;
  /** Category-template default condition (backlog T2); omit/null for none. */
  readonly defaultCondition?: Condition | null;
  /** Category-template default warranty window in whole months (backlog T2); omit/null for none. */
  readonly defaultWarrantyMonths?: number | null;
  /** Category-template default maintenance basis (backlog T2a); omit/null for none. */
  readonly defaultMaintenanceBasis?: MaintenanceBasis | null;
  /** TIME interval in days for the default maintenance schedule (backlog T2a); omit/null for none. */
  readonly defaultMaintenanceIntervalDays?: number | null;
  /** USAGE interval in units for the default maintenance schedule (backlog T2a); omit/null for none. */
  readonly defaultMaintenanceIntervalUsage?: number | null;
}

export interface UpdateCategoryInput {
  readonly name?: string;
  /** Optional decorative Unicode glyph/emoji (issue #83); null clears it. */
  readonly glyph?: string | null;
  /** Category-template default tracking mode (backlog T1); null clears it. */
  readonly defaultTrackingMode?: TrackingMode | null;
  /** Category-template default condition (backlog T2); null clears it. */
  readonly defaultCondition?: Condition | null;
  /** Category-template default warranty window in whole months (backlog T2); null clears it. */
  readonly defaultWarrantyMonths?: number | null;
  /** Category-template default maintenance basis (backlog T2a); null clears it. */
  readonly defaultMaintenanceBasis?: MaintenanceBasis | null;
  /** TIME interval in days for the default maintenance schedule (backlog T2a); null clears it. */
  readonly defaultMaintenanceIntervalDays?: number | null;
  /** USAGE interval in units for the default maintenance schedule (backlog T2a); null clears it. */
  readonly defaultMaintenanceIntervalUsage?: number | null;
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
  readonly description: string | null;
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
  /**
   * Optional author's note explaining what the field is for. When set, the item's
   * custom-field control shows a rich-Markdown info hint carrying this text — a
   * reminder of any field-specific guidance. Null when the field carries no note.
   */
  readonly description: string | null;
  readonly position: number;
  readonly updatedAt: number;
}

export interface CreateCategoryFieldInput {
  readonly name: string;
  readonly fieldType: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  /** Optional author's note about the field; omit/null for none. */
  readonly description?: string | null;
  readonly position?: number;
}

export interface UpdateCategoryFieldInput {
  readonly name?: string;
  readonly fieldType?: FieldType;
  readonly options?: string[] | null;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  /** Optional author's note about the field; null clears it. */
  readonly description?: string | null;
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
