/**
 * Unit tests for the OData CSDL `$metadata` builder — a well-formed document with the expected
 * entity model, and a drift guard keeping its Item entity in lockstep with the projectable
 * field registry.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_PROPERTIES, odataMetadataXml } from './odata-metadata.ts';
import { ITEM_FIELD_REGISTRY, ITEM_SUMMARY_DEFAULT_FIELDS } from './item-view.ts';

/** Quote a literal for embedding in a `RegExp` — property names are identifiers today, but a
 * future one carrying a metacharacter shouldn't silently turn the pattern into a wildcard. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('odataMetadataXml', () => {
  const xml = odataMetadataXml();

  it('is a CSDL v4 document with the three entity sets and their key', () => {
    expect(xml).toContain('<edmx:Edmx Version="4.0"');
    expect(xml).toContain('<EntityType Name="Item">');
    expect(xml).toContain('<PropertyRef Name="id"/>');
    for (const set of ['items', 'locations', 'categories']) {
      expect(xml).toContain(`<EntitySet Name="${set}"`);
    }
    // The complex types the item entity references.
    for (const complex of ['Placement', 'Capability', 'Gauge']) {
      expect(xml).toContain(`<ComplexType Name="${complex}">`);
    }
  });

  it('declares the collection navigation as EDM collections', () => {
    expect(xml).toContain('Type="Collection(Gubbins.Placement)"');
    expect(xml).toContain('Type="Collection(Gubbins.Capability)"');
  });

  it('references the Core vocabulary its annotations use', () => {
    expect(xml).toContain('<edmx:Include Namespace="Org.OData.Core.V1"');
  });

  it('marks every non-default item property as opt-in, and leaves the default ones bare', () => {
    // Scope the match to the Item entity type: several property names (`name`, `weight`,
    // `locationName`, …) recur in the complex types, so an unscoped search would let a missing
    // annotation pass on the strength of an unrelated element elsewhere in the document.
    const item = /<EntityType Name="Item">([\s\S]*?)<\/EntityType>/.exec(xml)?.[1];
    expect(item).toBeDefined();

    const defaults = new Set(ITEM_SUMMARY_DEFAULT_FIELDS);
    for (const { name } of ITEM_PROPERTIES) {
      const head = `<Property Name="${escapeRegExp(name)}" Type="[^"]+" Nullable="(?:true|false)"`;
      // The property element is self-closing when it carries no annotation.
      const bare = new RegExp(`${head}/>`);
      const annotated = new RegExp(
        `${head}>\\s*<Annotation Term="Org\\.OData\\.Core\\.V1\\.Description" String="Returned only when requested`,
      );
      expect({ name, optIn: annotated.test(item!), bare: bare.test(item!) }).toEqual({
        name,
        optIn: !defaults.has(name),
        bare: defaults.has(name),
      });
    }
  });

  it('states the default projection on the items entity set', () => {
    expect(xml).toContain(
      `String="A request without fields/include (or $select/$expand) returns: ${ITEM_SUMMARY_DEFAULT_FIELDS.join(', ')}."`,
    );
  });

  it('stays in lockstep with the item field registry (no drift)', () => {
    const metadataNames = new Set(ITEM_PROPERTIES.map((p) => p.name));
    const registryNames = new Set(ITEM_FIELD_REGISTRY.keys());
    // Every projectable field is described, and the metadata invents no extra fields.
    for (const name of registryNames) expect(metadataNames).toContain(name);
    for (const name of metadataNames) expect(registryNames).toContain(name);
  });
});
