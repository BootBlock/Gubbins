/**
 * OpenAPI spec tests: the committed `openapi.yaml` is generated from the typed
 * `openapiDocument` (single source of truth), so guard against drift, and sanity-check the
 * document's internal references so a broken spec can't ship.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openapiDocument, type JsonValue } from './openapi.ts';
import { emitYaml } from './openapi-yaml.ts';

const YAML_URL = new URL('../openapi.yaml', import.meta.url);

describe('openapi.yaml', () => {
  it('matches a fresh emit of the spec object (no drift)', async () => {
    const committed = await readFile(YAML_URL, 'utf8');
    expect(committed).toBe(emitYaml(openapiDocument));
  });
});

describe('openapiDocument', () => {
  const doc = openapiDocument as Record<string, any>;

  it('is OpenAPI 3 with a versioned info block', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.version).toBe('1.0.0');
  });

  it('describes every v1 endpoint under /api/v1 with a GET or (write) POST, secured by the bearer scheme', () => {
    const paths = doc.paths as Record<string, any>;
    // Every path is under /api/v1 EXCEPT the root Prometheus /metrics endpoint (the scrape
    // convention places it at the root, not under a version prefix).
    const rootExceptions = new Set(['/metrics']);
    for (const [path, ops] of Object.entries(paths)) {
      expect(
        path.startsWith('/api/v1') || rootExceptions.has(path),
        `${path} should be under /api/v1 (or a documented root exception)`,
      ).toBe(true);
      // Reads are GET; the opt-in write endpoints are POST. Every path must define one of them.
      expect(ops.get ?? ops.post, `${path} should have a GET or POST`).toBeDefined();
    }
    // The write endpoints are POST-only and tagged `writes`.
    expect(doc.paths['/api/v1/items/{id}/adjust-quantity'].post.tags).toContain('writes');
    expect(doc.paths['/api/v1/items/{id}/adjust-gauge'].post.tags).toContain('writes');
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('documents the read-only SSE event stream and the BridgeEvent schema (EI-1)', () => {
    const events = doc.paths['/api/v1/events'];
    expect(events.get.tags).toContain('events');
    // The stream is an event-stream media type, not JSON.
    expect(events.get.responses['200'].content['text/event-stream']).toBeDefined();
    // The event schema exists and references the shared ItemSummary for its payload.
    const bridgeEvent = doc.components.schemas.BridgeEvent;
    expect(bridgeEvent.required).toEqual(['id', 'type', 'occurredAt', 'data']);
    expect(bridgeEvent.properties.type.enum).toContain('item.low_stock');
    expect(bridgeEvent.properties.type.enum).toContain('stock.adjusted');
    expect(JSON.stringify(doc.components.schemas.BridgeEventData)).toContain(
      '#/components/schemas/ItemSummary',
    );
    // The discovery index advertises the stream toggle.
    expect(doc.components.schemas.ApiIndex.properties.streamable).toBeDefined();
  });

  it('documents the read-triggered lookup.resolved event and its payload (#62)', () => {
    const bridgeEvent = doc.components.schemas.BridgeEvent;
    // The read-triggered event is a documented member of the type enum...
    expect(bridgeEvent.properties.type.enum).toContain('lookup.resolved');
    // ...and the envelope's `data` admits its distinct shape alongside the ledger payload.
    const refs = bridgeEvent.properties.data.oneOf.map((entry: { $ref: string }) => entry.$ref);
    expect(refs).toContain('#/components/schemas/BridgeEventData');
    expect(refs).toContain('#/components/schemas/LookupEventData');
    // The payload carries the flattened unions an automation triggers on.
    const lookup = doc.components.schemas.LookupEventData;
    expect(lookup.required).toEqual(['query', 'itemIds', 'locationIds', 'matches']);
    // A placement must carry the location *id*, not just its name — that is what makes it actionable.
    const placement = lookup.properties.matches.items.properties.placements.items;
    expect(placement.required).toContain('locationId');
    // The departure from "every event derives from the ledger" is called out for consumers.
    expect(bridgeEvent.description).toContain('read');
  });

  it('documents the syndication feeds and the Prometheus /metrics endpoint (EI-6)', () => {
    const paths = doc.paths as Record<string, any>;
    // The three feed formats, each with its own media type, tagged `feeds`.
    expect(paths['/api/v1/activity.rss'].get.tags).toContain('feeds');
    expect(paths['/api/v1/activity.rss'].get.responses['200'].content['application/rss+xml']).toBeDefined();
    expect(paths['/api/v1/activity.atom'].get.responses['200'].content['application/atom+xml']).toBeDefined();
    expect(
      paths['/api/v1/activity.json'].get.responses['200'].content['application/feed+json'],
    ).toBeDefined();
    // Metrics: a root-path text/plain exposition tagged `metrics`.
    expect(paths['/metrics'].get.tags).toContain('metrics');
    expect(paths['/metrics'].get.responses['200'].content['text/plain']).toBeDefined();
  });

  it('documents custom-field values as an opt-in expansion on items and locations (A1)', () => {
    const doc2 = doc as Record<string, any>;
    // Both resources carry the field values, each with its own element schema.
    const itemDetail = doc2.components.schemas.ItemDetail.allOf[1];
    expect(itemDetail.properties.fieldValues.items.$ref).toBe('#/components/schemas/ItemFieldValue');
    expect(doc2.components.schemas.Location.properties.fieldValues.items.$ref).toBe(
      '#/components/schemas/LocationFieldValue',
    );
    // …and are OPTIONAL: neither schema lists fieldValues as required, because the default
    // payload does not contain it — a caller opts in with `include=fields`.
    expect(itemDetail.required).not.toContain('fieldValues');
    expect(doc2.components.schemas.Location.required).not.toContain('fieldValues');

    // An inherited value is distinguishable from a directly-set one.
    expect(doc2.components.schemas.ItemFieldValue.properties.source.enum).toEqual([
      'stored',
      'inherited',
      'default',
    ]);
    expect(doc2.components.schemas.LocationFieldValue.properties.isInheritable).toBeDefined();

    // The location endpoints advertise the `include` parameter that turns them on.
    for (const path of ['/api/v1/locations', '/api/v1/locations/{id}']) {
      const names = (doc2.paths[path].get.parameters as { name: string }[]).map((p) => p.name);
      expect(names, `${path} should accept include`).toContain('include');
      expect(names, `${path} should accept fields`).toContain('fields');
    }
  });

  it('has no dangling $ref — every referenced schema exists', () => {
    const schemas = new Set(Object.keys(doc.components.schemas));
    for (const ref of collectRefs(openapiDocument)) {
      const name = ref.replace('#/components/schemas/', '');
      expect(schemas.has(name), `missing schema for ${ref}`).toBe(true);
    }
  });
});

/** Walk the document collecting every `$ref` string value. */
function collectRefs(value: JsonValue, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}
