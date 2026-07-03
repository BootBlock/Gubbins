/**
 * Unit tests for the OData CSDL `$metadata` builder — a well-formed document with the expected
 * entity model, and a drift guard keeping its Item entity in lockstep with the projectable
 * field registry.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_PROPERTIES, odataMetadataXml } from './odata-metadata.ts';
import { ITEM_FIELD_REGISTRY } from './item-view.ts';

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

  it('stays in lockstep with the item field registry (no drift)', () => {
    const metadataNames = new Set(ITEM_PROPERTIES.map((p) => p.name));
    const registryNames = new Set(ITEM_FIELD_REGISTRY.keys());
    // Every projectable field is described, and the metadata invents no extra fields.
    for (const name of registryNames) expect(metadataNames).toContain(name);
    for (const name of metadataNames) expect(registryNames).toContain(name);
  });
});
