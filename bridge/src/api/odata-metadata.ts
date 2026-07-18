/**
 * A best-effort **OData v4 CSDL `$metadata` document** describing the bridge's read model
 * (the `items`, `locations`, `categories` entity sets and their complex types). It is served
 * at `GET /api/v1/$metadata` so OData-aware tooling can introspect the shapes.
 *
 * Honesty caveat (see the README): this is a *descriptive* CSDL for the read model, not a
 * declaration of full OData conformance — the service implements only the constrained query
 * subset (`$select`/`$expand`/`$top`/`$skip`/`$orderby`/`$filter`/`$count`/`$search`), not the
 * whole protocol. The document is static (no user input) and built from a small typed model, so
 * it stays in lockstep with the item field registry (guarded by a test).
 *
 * The entity types describe the **whole projectable shape**, which is wider than the payload a
 * default request returns: `GET /items` emits the summary field set, and everything else is
 * opt-in via `fields`/`include` (or `$select`/`$expand`). A reader can't infer that from the
 * property list alone, so each property outside its entity set's default payload carries an
 * `Org.OData.Core.V1.Description` saying so — otherwise tooling that materialises a table from
 * the CSDL (Excel, Power Query, LINQPad) builds columns that are always empty. The default sets
 * are imported from the field registries rather than restated here, so they can't drift.
 */
import { ITEM_SUMMARY_DEFAULT_FIELDS } from './item-view.ts';
import { LOCATION_DEFAULT_FIELDS } from './location-view.ts';

/** One EDM property: its name, EDM type, and whether it is nullable. */
interface EdmProperty {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

const p = (name: string, type: string, nullable = true): EdmProperty => ({ name, type, nullable });

/** The `Gubbins.Item` entity type — the full projectable item shape (keyed by `id`). */
export const ITEM_PROPERTIES: readonly EdmProperty[] = [
  p('id', 'Edm.String', false),
  p('name', 'Edm.String', false),
  // Nullable: an unlimited-supply item (isUnlimited) has no finite count, so quantity is null.
  p('quantity', 'Edm.Int64'),
  p('isUnlimited', 'Edm.Boolean', false),
  p('locationId', 'Edm.String', false),
  p('locationName', 'Edm.String'),
  p('categoryId', 'Edm.String'),
  p('categoryName', 'Edm.String'),
  p('mpn', 'Edm.String'),
  p('manufacturer', 'Edm.String'),
  p('trackingMode', 'Edm.String', false),
  p('isActive', 'Edm.Boolean', false),
  p('description', 'Edm.String'),
  p('notes', 'Edm.String'),
  p('condition', 'Edm.String'),
  p('serialNumber', 'Edm.String'),
  p('serialNo', 'Edm.Int64'),
  p('parentId', 'Edm.String'),
  p('unitCost', 'Edm.Decimal'),
  p('purchasePrice', 'Edm.Decimal'),
  p('weight', 'Edm.Decimal'),
  p('width', 'Edm.Decimal'),
  p('height', 'Edm.Decimal'),
  p('depth', 'Edm.Decimal'),
  p('expiryDate', 'Edm.Int64'),
  p('batchNumber', 'Edm.String'),
  p('lotNumber', 'Edm.String'),
  p('acquiredAt', 'Edm.String'),
  p('warrantyExpiresAt', 'Edm.String'),
  p('depreciationMonths', 'Edm.Int64'),
  p('reorderPoint', 'Edm.Int64'),
  p('reorderGaugePercent', 'Edm.Decimal'),
  p('reorderQty', 'Edm.Int64'),
  p('operationalMetadata', 'Edm.String'),
  p('gauge', 'Gubbins.Gauge'),
  p('createdAt', 'Edm.Int64', false),
  p('updatedAt', 'Edm.Int64', false),
  // Collection-valued: per CSDL v4.01 §7.1.1 `Nullable` describes the *elements*, not the
  // collection itself (which can never be null), so `false` reads "no null members" — it makes
  // no claim about the property being present. Presence is governed by the projection, which
  // the annotation on each of these spells out.
  p('placements', 'Collection(Gubbins.Placement)', false),
  p('capabilities', 'Collection(Gubbins.Capability)', false),
  p('fieldValues', 'Collection(Gubbins.ItemFieldValue)', false),
];

const PLACEMENT_PROPERTIES: readonly EdmProperty[] = [
  p('locationId', 'Edm.String', false),
  p('locationName', 'Edm.String', false),
  p('quantity', 'Edm.Int64', false),
];

const CAPABILITY_PROPERTIES: readonly EdmProperty[] = [
  p('key', 'Edm.String', false),
  p('valueNum', 'Edm.Double'),
  p('valueText', 'Edm.String'),
  p('weight', 'Edm.Double', false),
];

/** One resolved custom-field value of an item — nullable origin when it was inherited. */
const ITEM_FIELD_VALUE_PROPERTIES: readonly EdmProperty[] = [
  p('name', 'Edm.String', false),
  p('fieldType', 'Edm.String', false),
  p('value', 'Edm.String', false),
  p('source', 'Edm.String', false),
  p('inheritedFrom', 'Gubbins.FieldOrigin'),
];

/** The location an inherited field value came from. */
const FIELD_ORIGIN_PROPERTIES: readonly EdmProperty[] = [
  p('locationId', 'Edm.String', false),
  p('locationName', 'Edm.String', false),
];

/** One custom-field value a location holds. */
const LOCATION_FIELD_VALUE_PROPERTIES: readonly EdmProperty[] = [
  p('name', 'Edm.String', false),
  p('fieldType', 'Edm.String', false),
  p('value', 'Edm.String', false),
  p('isInheritable', 'Edm.Boolean', false),
];

const GAUGE_PROPERTIES: readonly EdmProperty[] = [
  p('unitOfMeasure', 'Edm.String', false),
  p('grossCapacity', 'Edm.Double', false),
  p('tareWeight', 'Edm.Double', false),
  p('currentNetValue', 'Edm.Double', false),
  p('percentageRemaining', 'Edm.Double', false),
  p('currentGrossWeight', 'Edm.Double', false),
  // Nullable: an item with no attrition rate reports null rather than zero.
  p('attritionPercent', 'Edm.Double', true),
];

const LOCATION_PROPERTIES: readonly EdmProperty[] = [
  p('id', 'Edm.String', false),
  p('name', 'Edm.String', false),
  p('parentId', 'Edm.String'),
  p('isSystem', 'Edm.Boolean', false),
  p('description', 'Edm.String'),
  p('color', 'Edm.String'),
  p('itemCount', 'Edm.Int64', false),
  p('fieldValues', 'Collection(Gubbins.LocationFieldValue)', false),
];

const CATEGORY_PROPERTIES: readonly EdmProperty[] = [
  p('id', 'Edm.String', false),
  p('name', 'Edm.String', false),
  p('fieldCount', 'Edm.Int64', false),
];

/** Escape the five XML entities so an identifier/type can never break the document. */
function xml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&apos;',
  );
}

/**
 * An `Org.OData.Core.V1.Description` annotation, indented to sit inside a `<Property>` or an
 * `<EntitySet>` — both of which this document nests two levels deeper than the schema body.
 */
function description(text: string): string {
  return `          <Annotation Term="Org.OData.Core.V1.Description" String="${xml(text)}"/>`;
}

/**
 * One `<Property>`. Properties outside their entity's default payload are annotated as opt-in
 * rather than silently declared, so a CSDL reader knows a plain request won't return them.
 */
function property({ name, type, nullable }: EdmProperty, defaults?: ReadonlySet<string>): string {
  const head = `        <Property Name="${xml(name)}" Type="${xml(type)}" Nullable="${nullable}"`;
  if (!defaults || defaults.has(name)) return `${head}/>`;
  return [
    `${head}>`,
    description(
      'Returned only when requested with fields/include (or $select/$expand); not part of the default payload.',
    ),
    `        </Property>`,
  ].join('\n');
}

function entityType(
  name: string,
  key: string,
  properties: readonly EdmProperty[],
  defaults?: ReadonlySet<string>,
): string {
  return [
    `      <EntityType Name="${xml(name)}">`,
    `        <Key><PropertyRef Name="${xml(key)}"/></Key>`,
    // Bound explicitly rather than passed as `map(property)` — that hands `map` the index as
    // the `defaults` argument.
    ...properties.map((prop) => property(prop, defaults)),
    `      </EntityType>`,
  ].join('\n');
}

function complexType(name: string, properties: readonly EdmProperty[]): string {
  return [
    `      <ComplexType Name="${xml(name)}">`,
    ...properties.map((prop) => property(prop)),
    `      </ComplexType>`,
  ].join('\n');
}

/** The default payloads as lookups, for deciding which properties need the opt-in annotation. */
const ITEM_DEFAULTS: ReadonlySet<string> = new Set(ITEM_SUMMARY_DEFAULT_FIELDS);
const LOCATION_DEFAULTS: ReadonlySet<string> = new Set(LOCATION_DEFAULT_FIELDS);

/**
 * One `<EntitySet>`, annotated with the field set a default (unprojected) request returns so a
 * CSDL reader isn't left to assume it gets the entity type's whole property list.
 */
function entitySet(name: string, type: string, defaults?: readonly string[]): string {
  const head = `        <EntitySet Name="${xml(name)}" EntityType="${xml(type)}"`;
  if (!defaults) return `${head}/>`;
  return [
    `${head}>`,
    description(`A request without fields/include (or $select/$expand) returns: ${defaults.join(', ')}.`),
    `        </EntitySet>`,
  ].join('\n');
}

/**
 * Build the CSDL `$metadata` XML for the read model. Static (no request/user input), so it can
 * be memoised by the caller if desired; it is small enough to build per request.
 */
export function odataMetadataXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">',
    // The Core vocabulary the Description annotations below are drawn from.
    '  <edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml">',
    '    <edmx:Include Namespace="Org.OData.Core.V1" Alias="Core"/>',
    '  </edmx:Reference>',
    '  <edmx:DataServices>',
    '    <Schema Namespace="Gubbins" xmlns="http://docs.oasis-open.org/odata/ns/edm">',
    entityType('Item', 'id', ITEM_PROPERTIES, ITEM_DEFAULTS),
    entityType('Location', 'id', LOCATION_PROPERTIES, LOCATION_DEFAULTS),
    // Categories have no extended fields — every declared property is always returned.
    entityType('Category', 'id', CATEGORY_PROPERTIES),
    complexType('Placement', PLACEMENT_PROPERTIES),
    complexType('Capability', CAPABILITY_PROPERTIES),
    complexType('Gauge', GAUGE_PROPERTIES),
    complexType('ItemFieldValue', ITEM_FIELD_VALUE_PROPERTIES),
    complexType('LocationFieldValue', LOCATION_FIELD_VALUE_PROPERTIES),
    complexType('FieldOrigin', FIELD_ORIGIN_PROPERTIES),
    '      <EntityContainer Name="Container">',
    entitySet('items', 'Gubbins.Item', ITEM_SUMMARY_DEFAULT_FIELDS),
    entitySet('locations', 'Gubbins.Location', LOCATION_DEFAULT_FIELDS),
    entitySet('categories', 'Gubbins.Category'),
    '      </EntityContainer>',
    '    </Schema>',
    '  </edmx:DataServices>',
    '</edmx:Edmx>',
    '',
  ].join('\n');
}
