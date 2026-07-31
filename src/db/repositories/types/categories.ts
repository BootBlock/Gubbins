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
  /**
   * The open databases this category's fields can be filled from (issue #616) — a JSON array
   * of `{ providerId, fieldMap? }` entries, or null when no lookup is attached. Parsed
   * tolerantly at the mapper boundary.
   */
  readonly lookup_sources: string | null;
  /**
   * Where this category's custom fields sit in the item dialog (issue #619) — one of
   * `default` / `promoted` / `own-tab`, or null for the default. Stored verbatim and narrowed
   * at the render boundary, so a mode a newer peer invented survives a round-trip.
   */
  readonly field_prominence: string | null;
  /** Label for the `own-tab` break-out tab (issue #619); null falls back to the built-in one. */
  readonly field_tab_label: string | null;
  readonly updated_at: number;
}

/**
 * One open database attached to a category (issue #616): the provider to run, and optionally
 * where its values should land.
 *
 * `providerId` names an entry in the app's curated lookup registry. It is **not** narrowed to
 * the ids this build knows, for the same reason `hiddenCapabilities` isn't: a peer on a newer
 * version may attach a provider that doesn't exist here yet, and narrowing on read would
 * quietly discard its choice the next time this device writes the row back.
 */
export interface CategoryLookupSource {
  /** The registry id of the provider to run (`wikidata-film`). */
  readonly providerId: string;
  /**
   * Explicit output-key → target overrides, for a category whose field has been renamed or
   * re-purposed so the provider's default name match no longer finds it. Each value is a
   * `category_fields.id`, or one of the reserved `builtin:` target ids. Null (the common case)
   * means every key binds by name.
   */
  readonly fieldMap: Readonly<Record<string, string>> | null;
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
  /**
   * The open databases this category's fields can be filled from (issue #616). Empty when no
   * lookup is attached; a malformed stored value reads as empty rather than throwing.
   *
   * Entries are kept **verbatim**, unrecognised provider ids included — see
   * {@link CategoryLookupSource}. Resolving an id to a provider (and therefore deciding
   * whether this build can offer the lookup at all) is the feature layer's job, not storage's.
   */
  readonly lookupSources: readonly CategoryLookupSource[];
  /**
   * Where this category's custom fields sit in the item dialog (issue #619): `default` leaves
   * them inside **Classification**, `promoted` moves that tab up to sit directly after
   * **Details**, and `own-tab` breaks the custom fields out into a tab of their own there.
   *
   * Deliberately `string` rather than a union, for the same reason `hiddenCapabilities` is
   * `string[]`: this layer is imported by the bridge, and the value is kept **verbatim** so a
   * mode a newer peer invented is not discarded the next time this device writes the row back.
   * `toFieldProminenceMode` in `features/inventory/field-prominence.ts` is the render boundary
   * that narrows it — an unrecognised mode reads as `default` there.
   */
  readonly fieldProminence: string | null;
  /**
   * The label for the `own-tab` break-out tab (issue #619); null falls back to the built-in
   * "Custom fields". Retained while another mode is selected, so switching modes doesn't
   * discard the wording the user chose.
   */
  readonly fieldTabLabel: string | null;
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
  /** Open databases this category's fields can be filled from (issue #616); omit/empty for none. */
  readonly lookupSources?: readonly CategoryLookupSource[] | null;
  /** Where this category's custom fields sit (issue #619); omit/null for the default position. */
  readonly fieldProminence?: string | null;
  /** Label for the `own-tab` break-out tab (issue #619); omit/null for the built-in label. */
  readonly fieldTabLabel?: string | null;
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
  /** Open databases this category's fields can be filled from (issue #616); null or `[]` clears it. */
  readonly lookupSources?: readonly CategoryLookupSource[] | null;
  /** Where this category's custom fields sit (issue #619); null restores the default position. */
  readonly fieldProminence?: string | null;
  /** Label for the `own-tab` break-out tab (issue #619); null restores the built-in label. */
  readonly fieldTabLabel?: string | null;
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
  readonly due_lead_days: number | null;
  readonly unit: string | null;
  readonly min_value: number | null;
  readonly max_value: number | null;
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
  /**
   * The **due-date opt-in** for a `DATE` field (W1a): how many calendar days' notice the
   * alert centre and the Upcoming agenda give before the stored date falls due. `null` —
   * the default, and the only legal value on any non-`DATE` type — means the field is an
   * ordinary date that raises nothing, which is right for "Date acquired" and wrong only
   * for the deadlines a user explicitly nominates.
   *
   * It lives on the **definition**, so it is shared by every category using that field —
   * deliberately, because a field's name is its identity here and "Renewal date" means the
   * same thing wherever it appears.
   */
  readonly dueLeadDays: number | null;
  /**
   * The **unit of measure** for a `NUMBER` field (W1b) — a symbol such as `mm`, `V` or `kg`,
   * shown beside the value wherever one is displayed. `null` — the default, and the only legal
   * value on any non-`NUMBER` type — means the number is unitless.
   *
   * Never a blank string: the write seam folds one to `null`, so "no unit" has a single
   * spelling. Like {@link dueLeadDays} it lives on the **definition**, because a field named
   * "Voltage" is measured in volts wherever it is used.
   */
  readonly unit: string | null;
  /**
   * The lower bound of a `NUMBER` field's accepted **range** (W1c), enforced at the point of
   * save by `validateFieldValue`. `null` means unbounded below.
   *
   * The two bounds are **independent**: either may be set without the other, so "never
   * negative" ({@link minValue} alone) and "at most 100" ({@link maxValue} alone) are both
   * expressible. What is refused is an *inverted* pair — a range no value can satisfy is a
   * broken field rather than a strict one — while equal bounds mean "exactly this".
   */
  readonly minValue: number | null;
  /** The upper bound of a `NUMBER` field's accepted range; `null` is unbounded above. See {@link minValue}. */
  readonly maxValue: number | null;
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
  readonly due_lead_days: number | null;
  readonly unit: string | null;
  readonly min_value: number | null;
  readonly max_value: number | null;
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
  /**
   * The dictionary definition's due-date opt-in — see {@link FieldDef.dueLeadDays}. Carried
   * onto the category's view of the field so the field editor can show and change it without
   * a second read; it is a *definition* attribute, so editing it here changes it everywhere.
   */
  readonly dueLeadDays: number | null;
  /**
   * The dictionary definition's unit of measure — see {@link FieldDef.unit}. Carried onto the
   * category's view of the field so the editor and every value surface can render it without a
   * second read; a *definition* attribute, so editing it here changes it everywhere.
   */
  readonly unit: string | null;
  /** The definition's lower bound — see {@link FieldDef.minValue}. Definition-wide, like {@link unit}. */
  readonly minValue: number | null;
  /** The definition's upper bound — see {@link FieldDef.maxValue}. Definition-wide, like {@link unit}. */
  readonly maxValue: number | null;
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
  /**
   * Opt a `DATE` field in as a **due date**, with this many calendar days' notice (W1a).
   * Omit/null for an ordinary date.
   *
   * When the name resolves to a definition that already exists, a value here is *applied*
   * to it (the user is stating what the field means) but null/omitted never *clears* an
   * existing opt-in — adding "Renewal date" to a second category must not silently stop the
   * first category's items alerting.
   */
  readonly dueLeadDays?: number | null;
  /**
   * The unit of measure for a `NUMBER` field (W1b); omit/null for a unitless number. Follows
   * the same reuse rule as {@link dueLeadDays}: a value here is *applied* to an existing
   * definition, but null/omitted never clears one that is already set.
   */
  readonly unit?: string | null;
  /**
   * The lower bound of a `NUMBER` field's range (W1c); omit/null for unbounded below. Applied
   * on reuse and never cleared by omission, like {@link unit}.
   */
  readonly minValue?: number | null;
  /** The upper bound of a `NUMBER` field's range; omit/null for unbounded above. See {@link minValue}. */
  readonly maxValue?: number | null;
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
  /**
   * The due-date opt-in (W1a); `null` clears it, turning the field back into an ordinary
   * date. A *definition* attribute, so this reaches every category and location using the
   * field. Rejected on a non-`DATE` field; retyping away from `DATE` clears it.
   */
  readonly dueLeadDays?: number | null;
  /**
   * The unit of measure (W1b); `null` or a blank string clears it. A *definition* attribute,
   * so this reaches every category and location using the field. Rejected on a non-`NUMBER`
   * field; retyping away from `NUMBER` clears it.
   */
  readonly unit?: string | null;
  /**
   * The lower bound of the accepted range (W1c); `null` clears it, leaving the field unbounded
   * below. Rejected on a non-`NUMBER` field, and rejected when it would invert the range
   * against the effective {@link maxValue}; retyping away from `NUMBER` clears it.
   */
  readonly minValue?: number | null;
  /** The upper bound of the accepted range; `null` leaves the field unbounded above. See {@link minValue}. */
  readonly maxValue?: number | null;
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
  /**
   * The definition's unit and range — see {@link FieldDef.unit} / {@link FieldDef.minValue}.
   * Carried here for the same reason the identity half is: a location's value is edited and
   * validated against the *definition*, so the editor must be able to label the control with
   * its unit and the repository must be able to hold the value to the same range an item's is
   * held to. Without them a location would be the one place a range could be side-stepped.
   */
  readonly unit: string | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
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

/**
 * One item's value for a custom `DATE` field that its definition has opted in as a **due
 * date** (W1a) — the row {@link ItemFeedRepository.listFieldDueDates} returns and the alert
 * centre / Upcoming agenda lanes are built from.
 *
 * Flat rather than nested because the feed is a projection, not an entity: it exists to answer
 * "which recorded dates are due, and how much notice did the user ask for", and every consumer
 * needs the item and the field named together.
 */
export interface FieldDueDate {
  readonly itemId: string;
  readonly itemName: string;
  /** The dictionary definition the value belongs to — see {@link FieldDef}. */
  readonly defId: string;
  /** The definition's name, as the user sees it on the item ("Renewal date"). */
  readonly fieldName: string;
  /** The definition's notice period in calendar days — see {@link FieldDef.dueLeadDays}. */
  readonly leadDays: number;
  /** UNIX-ms midnight-UTC instant of the stored `YYYY-MM-DD` day (issue #320). */
  readonly dueAt: number;
}

/**
 * The raw projection behind {@link FieldDueDate}. `value` is the canonical `YYYY-MM-DD` the
 * query has already shape-checked (`GLOB`) and confirmed is a real calendar day
 * (`date(value) = value` — an equality, because SQLite's `date()` normalises an impossible day
 * rather than rejecting it; see `listFieldDueDates`), so the mapper can parse it without a
 * failure branch.
 */
export interface FieldDueDateRow {
  readonly item_id: string;
  readonly item_name: string;
  readonly def_id: string;
  readonly field_name: string;
  readonly due_lead_days: number;
  readonly value: string;
}
