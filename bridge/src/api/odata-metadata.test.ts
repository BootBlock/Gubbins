/**
 * Unit tests for the OData CSDL `$metadata` builder — a well-formed document with the expected
 * entity model, and a drift guard keeping its Item entity in lockstep with the projectable
 * field registry.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_SORT_FIELDS } from '@/db/repositories/item/sql.ts';
import {
  ENTITY_SET_CAPABILITIES,
  ITEM_PROPERTIES,
  odataMetadataXml,
  type SetCapabilities,
} from './odata-metadata.ts';
import { ODATA_ENTITY_SETS, SUPPORTED_OPTIONS } from './odata-service.ts';
import { ITEM_FIELD_REGISTRY, ITEM_SUMMARY_DEFAULT_FIELDS } from './item-view.ts';
import { FILTERABLE_PROPERTIES } from './odata-filter.ts';

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

  /** The body of one `<EntitySet>`, so a claim can be scoped to the set it is made about. */
  function entitySet(name: string): string {
    const body = new RegExp(`<EntitySet Name="${name}"[^>]*>([\\s\\S]*?)</EntitySet>`).exec(xml)?.[1];
    expect(body, `no <EntitySet Name="${name}"> body`).toBeDefined();
    return body!;
  }

  it('references the Capabilities vocabulary its restrictions use', () => {
    expect(xml).toContain('<edmx:Include Namespace="Org.OData.Capabilities.V1"');
  });

  it('names exactly the item properties that can be filtered and sorted', () => {
    const items = entitySet('items');
    const nonFilterable = /Property="NonFilterableProperties">\s*<Collection>([\s\S]*?)<\/Collection>/.exec(
      items,
    )?.[1];
    const nonSortable = /Property="NonSortableProperties">\s*<Collection>([\s\S]*?)<\/Collection>/.exec(
      items,
    )?.[1];
    const paths = (block: string | undefined): string[] =>
      [...(block ?? '').matchAll(/<PropertyPath>(.*?)<\/PropertyPath>/g)].map((m) => m[1]!);

    // The restriction is stated as the *complement*, so assert against the whole property list:
    // a new property must land on one side or the other, never silently in neither.
    const all = ITEM_PROPERTIES.map((p) => p.name);
    expect(paths(nonFilterable).sort()).toEqual(all.filter((n) => !FILTERABLE_PROPERTIES.includes(n)).sort());
    expect(paths(nonSortable).sort()).toEqual(
      all.filter((n) => !(ITEM_SORT_FIELDS as readonly string[]).includes(n)).sort(),
    );
  });

  it('declares items countable and searchable, and the other two sets neither', () => {
    expect(entitySet('items')).toContain('<PropertyValue Property="Countable" Bool="true"/>');
    expect(entitySet('items')).toContain('<PropertyValue Property="Searchable" Bool="true"/>');
    for (const set of ['locations', 'categories']) {
      const body = entitySet(set);
      expect(body).toContain('<PropertyValue Property="Filterable" Bool="false"/>');
      expect(body).toContain('<PropertyValue Property="Sortable" Bool="false"/>');
      expect(body).toContain('<PropertyValue Property="Countable" Bool="false"/>');
      expect(body).toContain('<PropertyValue Property="Searchable" Bool="false"/>');
    }
  });

  it('declares every entity set read-only — the bridge serves a snapshot it cannot write', () => {
    for (const set of ['items', 'locations', 'categories']) {
      const body = entitySet(set);
      for (const flag of ['Insertable', 'Updatable', 'Deletable']) {
        expect(body).toContain(`<PropertyValue Property="${flag}" Bool="false"/>`);
      }
    }
  });

  it('states the protocol facts a client would otherwise have to discover by failing', () => {
    expect(xml).toContain('Term="Org.OData.Capabilities.V1.BatchSupported" Bool="false"');
    expect(xml).toContain('<String>contains</String>'); // the only filter function implemented
  });

  it('stays in lockstep with the item field registry (no drift)', () => {
    const metadataNames = new Set(ITEM_PROPERTIES.map((p) => p.name));
    const registryNames = new Set(ITEM_FIELD_REGISTRY.keys());
    // Every projectable field is described, and the metadata invents no extra fields.
    for (const name of registryNames) expect(metadataNames).toContain(name);
    for (const name of metadataNames) expect(registryNames).toContain(name);
  });
});

describe('the CSDL and the router agree on what each entity set supports', () => {
  // The whole point of issue #361 was a document that advertised more than the service delivered.
  // The metadata states capabilities in vocabulary terms and the router enforces them as an
  // option allow-list; nothing but this test stops the two tables drifting back apart, and a
  // client that trusts the CSDL over the behaviour would then fail exactly as it used to.
  const CLAIM: readonly [keyof SetCapabilities, string][] = [
    ['filterable', '$filter'],
    ['sortable', '$orderby'],
    ['countable', '$count'],
    ['searchable', '$search'],
  ];

  for (const set of ODATA_ENTITY_SETS) {
    it(`${set}: every declared capability is an option the router accepts, and vice versa`, () => {
      const caps = ENTITY_SET_CAPABILITIES[set]!;
      const { collection, count } = SUPPORTED_OPTIONS[set];
      for (const [capability, option] of CLAIM) {
        expect({ capability, declared: caps[capability] !== false }).toEqual({
          capability,
          declared: collection.includes(option),
        });
      }
      // `Countable` also governs whether `/$count` is an addressable resource at all.
      expect(caps.countable).toBe(count !== null);
    });
  }
});
