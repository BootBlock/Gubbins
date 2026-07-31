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
  /**
   * Capabilities this category's items don't have (issue #618) — a JSON array of `FeatureId`
   * strings, or null when nothing is hidden. Parsed tolerantly at the mapper boundary.
   */
  readonly hidden_capabilities: string | null;
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
  /**
   * Capabilities this category's items don't have (issue #618) — the ids of module
   * capabilities whose item-detail sections this category suppresses. Empty when nothing is
   * hidden; a malformed stored value reads as empty rather than throwing.
   *
   * Deliberately `string[]` rather than `FeatureId[]`: this layer is imported by the bridge,
   * and the feature registry that owns `FeatureId` drags in icons and route types. Ids are
   * also kept **verbatim**, including any this build doesn't recognise — a peer on a newer
   * version may hide a capability that doesn't exist here yet, and narrowing on read would
   * quietly discard its choice the next time this device writes the row back. Recognition is
   * the render boundary's job, not storage's.
   */
  readonly hiddenCapabilities: readonly string[];
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
  /** Capabilities this category's items don't have (issue #618); omit/empty for none. */
  readonly hiddenCapabilities?: readonly string[] | null;
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
  /** Capabilities this category's items don't have (issue #618); null or `[]` clears it. */
  readonly hiddenCapabilities?: readonly string[] | null;
}

// --- Category custom fields (spec §4 "Categories & Schema Evolution") -----------

/**
 * A row of the global **field dictionary** (issue #97) — a custom field's identity,
 * owned by no single category. Categories and locations reference a definition; the
 * shared def id is what links a location's inheritable value to the item field it feeds.
 */
export interface FieldDefRow {
  readonly id: string;
  readonly name: string;
  readonly field_type: FieldType;
  readonly options: string | null;
  readonly description: string | null;
  readonly updated_at: number;
}

/** {@link FieldDefRow} as a DTO. */
export interface FieldDef {
  readonly id: string;
  readonly name: string;
  readonly fieldType: FieldType;
  /** Choice list for `SELECT` fields; null otherwise. */
  readonly options: string[] | null;
  /**
   * Optional author's note explaining what the field is for. When set, the item's
   * custom-field control shows a rich-Markdown info hint carrying this text — a
   * reminder of any field-specific guidance. Null when the field carries no note.
   */
  readonly description: string | null;
  readonly updatedAt: number;
}

/**
 * A category's *use* of a dictionary definition, joined to that definition — the shape
 * the query layer reads (`category_fields` LEFT JOIN `field_defs`). Storage is
 * normalised; this row stays denormalised so callers see one flat field.
 */
export interface CategoryFieldRow {
  readonly id: string;
  readonly category_id: string;
  readonly def_id: string;
  readonly name: string;
  readonly field_type: FieldType;
  readonly options: string | null;
  readonly is_required: number;
  readonly default_value: string | null;
  readonly description: string | null;
  readonly position: number;
  readonly updated_at: number;
}

/**
 * One custom field as a category presents it: the dictionary definition's identity
 * (`name`/`fieldType`/`options`/`description`) plus the policy that is genuinely
 * category-local (`isRequired`/`defaultValue`/`position`).
 *
 * `id` is the `category_fields` row — the category's *use* of the field — while
 * {@link defId} is the dictionary definition shared across categories and locations.
 * Inheritance always keys on `defId`; never on `id`.
 */
export interface CategoryField {
  readonly id: string;
  readonly categoryId: string;
  /** The dictionary definition this field uses. The identity inheritance keys on. */
  readonly defId: string;
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

/**
 * Add a custom field to a category. The identity half (`name`/`fieldType`/`options`/
 * `description`) resolves against the global dictionary **by name**: an existing
 * definition is reused, otherwise one is created. Reuse is the point — it is what
 * makes two categories' "Manufacturer" the *same* field, and therefore what makes a
 * location's inheritable Manufacturer reach items in either category.
 *
 * Because a name identifies a definition, adding a field whose name already exists
 * with a **different** `fieldType` is rejected rather than silently retyping the
 * shared definition out from under every other user of it.
 */
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

/**
 * Update a category's use of a field. The identity half (`name`/`fieldType`/`options`/
 * `description`) edits the shared **dictionary definition**, so it is visible to every
 * category and location using it; the policy half (`isRequired`/`defaultValue`/
 * `position`) is category-local.
 */
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
 * How an item's value for a custom field is arrived at (issue #97).
 *
 * - `literal` — the item stores its own value.
 * - `inherit` — the item defers to the nearest ancestor location offering an
 *   inheritable value for this definition, re-resolved on every read.
 */
export type FieldValueMode = 'literal' | 'inherit';

/** Where a resolved value actually came from. Drives what the editor shows. */
export type FieldValueSource = 'stored' | 'inherited' | 'default';

/**
 * A category field resolved against a specific item's stored value, applying
 * **lenient defaulting** (spec §4): when no value row exists the field's
 * `defaultValue` (or null) is returned silently — no migration of existing rows.
 *
 * Issue #97 adds location inheritance ahead of the default: an item whose stored
 * `mode` is `inherit` takes the nearest ancestor location's inheritable value.
 */
export interface ResolvedItemField extends CategoryField {
  /** The effective value: stored, inherited, or the field default (in that order). */
  readonly value: string | null;
  /** True when the value came from a stored row rather than the default. */
  readonly hasStoredValue: boolean;
  /** The item's stored intent for this field; `literal` when nothing is stored. */
  readonly mode: FieldValueMode;
  /** Which of the three sources {@link value} actually came from. */
  readonly source: FieldValueSource;
  /**
   * When some ancestor location offers an inheritable value for this definition, the
   * value it would supply — present whether or not the item is currently inheriting,
   * so the editor can offer `<Inherit>` and preview what it resolves to. Null when no
   * ancestor offers one (in which case `<Inherit>` is not offered at all).
   */
  readonly inheritable: InheritableFieldValue | null;
}

/** An inheritable value offered to an item by one of its ancestor locations. */
export interface InheritableFieldValue {
  /** The value the ancestor supplies. */
  readonly value: string | null;
  /** The location the value came from — shown so the user knows *where* it is set. */
  readonly locationId: string;
  readonly locationName: string;
}

// --- Location field values (issue #97) -----------------------------------------

export interface LocationFieldValueRow {
  readonly id: string;
  readonly location_id: string;
  readonly def_id: string;
  readonly value: string | null;
  readonly is_inheritable: number;
  readonly updated_at: number;
}

/**
 * A location's value for a dictionary definition, joined to that definition. Only
 * rows with `isInheritable` are offered to the items and child locations beneath.
 */
export interface LocationFieldValue {
  readonly id: string;
  readonly locationId: string;
  readonly defId: string;
  readonly name: string;
  readonly fieldType: FieldType;
  readonly options: string[] | null;
  readonly description: string | null;
  readonly value: string | null;
  /** Opt-in: when false the value is the location's own metadata and is not offered. */
  readonly isInheritable: boolean;
  readonly updatedAt: number;
}

export interface SetLocationFieldValueInput {
  readonly defId: string;
  readonly value: string | null;
  readonly isInheritable?: boolean;
}
