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
 */

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
  p('quantity', 'Edm.Int64', false),
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
  p('serialNo', 'Edm.Int64'),
  p('parentId', 'Edm.String'),
  p('unitCost', 'Edm.Decimal'),
  p('purchasePrice', 'Edm.Decimal'),
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
  p('placements', 'Collection(Gubbins.Placement)', false),
  p('capabilities', 'Collection(Gubbins.Capability)', false),
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

const GAUGE_PROPERTIES: readonly EdmProperty[] = [
  p('unitOfMeasure', 'Edm.String', false),
  p('grossCapacity', 'Edm.Double', false),
  p('tareWeight', 'Edm.Double', false),
  p('currentNetValue', 'Edm.Double', false),
  p('percentageRemaining', 'Edm.Double', false),
  p('currentGrossWeight', 'Edm.Double', false),
];

const LOCATION_PROPERTIES: readonly EdmProperty[] = [
  p('id', 'Edm.String', false),
  p('name', 'Edm.String', false),
  p('parentId', 'Edm.String'),
  p('isSystem', 'Edm.Boolean', false),
  p('description', 'Edm.String'),
  p('color', 'Edm.String'),
  p('itemCount', 'Edm.Int64', false),
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

function property({ name, type, nullable }: EdmProperty): string {
  return `        <Property Name="${xml(name)}" Type="${xml(type)}" Nullable="${nullable}"/>`;
}

function entityType(name: string, key: string, properties: readonly EdmProperty[]): string {
  return [
    `      <EntityType Name="${xml(name)}">`,
    `        <Key><PropertyRef Name="${xml(key)}"/></Key>`,
    ...properties.map(property),
    `      </EntityType>`,
  ].join('\n');
}

function complexType(name: string, properties: readonly EdmProperty[]): string {
  return [
    `      <ComplexType Name="${xml(name)}">`,
    ...properties.map(property),
    `      </ComplexType>`,
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
    '  <edmx:DataServices>',
    '    <Schema Namespace="Gubbins" xmlns="http://docs.oasis-open.org/odata/ns/edm">',
    entityType('Item', 'id', ITEM_PROPERTIES),
    entityType('Location', 'id', LOCATION_PROPERTIES),
    entityType('Category', 'id', CATEGORY_PROPERTIES),
    complexType('Placement', PLACEMENT_PROPERTIES),
    complexType('Capability', CAPABILITY_PROPERTIES),
    complexType('Gauge', GAUGE_PROPERTIES),
    '      <EntityContainer Name="Container">',
    '        <EntitySet Name="items" EntityType="Gubbins.Item"/>',
    '        <EntitySet Name="locations" EntityType="Gubbins.Location"/>',
    '        <EntitySet Name="categories" EntityType="Gubbins.Category"/>',
    '      </EntityContainer>',
    '    </Schema>',
    '  </edmx:DataServices>',
    '</edmx:Edmx>',
    '',
  ].join('\n');
}
