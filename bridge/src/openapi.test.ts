/**
 * OpenAPI spec tests: the committed `openapi.yaml` is generated from the typed
 * `openapiDocument` (single source of truth), so guard against drift, and sanity-check the
 * document's internal references so a broken spec can't ship.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openapiDocument, type JsonValue } from './openapi.ts';
import { emitYaml } from './openapi-yaml.ts';
import { API_ERROR_CODES } from './api/respond.ts';
import {
  ITEM_DETAIL_DEFAULT_FIELDS,
  ITEM_FIELD_REGISTRY,
  ITEM_SUMMARY_DEFAULT_FIELDS,
} from './api/item-view.ts';
import { LOCATION_FIELD_REGISTRY } from './api/location-view.ts';

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
    // …and are OPTIONAL: neither schema makes fieldValues required, because the default
    // payload does not contain it — a caller opts in with `include=fields`. (Location declares
    // nothing required at all; both of its reads accept a sparse fieldset — see #367 below.)
    expect(itemDetail.required).not.toContain('fieldValues');
    expect(doc2.components.schemas.Location.required).toBeUndefined();

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

  it('publishes every error code the bridge can actually send (#367)', () => {
    expect(doc.components.schemas.Error.properties.error.properties.code.enum).toEqual([...API_ERROR_CODES]);
  });

  it('declares the responses reachable at every path — 405, 500 and 503 (#367)', () => {
    for (const [path, item] of Object.entries(doc.paths as Record<string, any>)) {
      for (const method of ['get', 'post']) {
        const op = item[method];
        if (op === undefined) continue;
        // All three are answered by request-wrapping code in server.ts — the method guard, the
        // snapshot-loaded gate and the outer catch-all — every one of which runs before the
        // request is routed. They belong to no single operation, and OpenAPI 3 has nowhere but
        // each operation to declare them.
        expect(Object.keys(op.responses), `${method.toUpperCase()} ${path}`).toEqual(
          expect.arrayContaining(['405', '500', '503']),
        );
      }
    }
  });

  it('declares the 404 that an opt-in operation’s own description promises (#367)', () => {
    // Every opt-in surface says "returns 404 when disabled" in its description — an operator
    // reading the document is told the code, so the responses map has to list it too.
    for (const [path, item] of Object.entries(doc.paths as Record<string, any>)) {
      for (const op of [item.get, item.post].filter(Boolean)) {
        if (!/returns 404 when/.test(op.description ?? '')) continue;
        expect(Object.keys(op.responses), `${path} promises a 404`).toContain('404');
      }
    }
  });

  it('describes each path’s errors in the envelope that path actually sends (#367)', () => {
    // `respond.ts` picks the envelope from the path: the structured `{ error: { code, message } }`
    // under /api/v1, and the flat `{ error: "…" }` on an unversioned path. /metrics is the only
    // unversioned path here, and pointing it at the structured schema made every error it sends
    // a documented contract violation.
    for (const [path, item] of Object.entries(doc.paths as Record<string, any>)) {
      const expected = path.startsWith('/api/v1')
        ? '#/components/schemas/Error'
        : '#/components/schemas/LegacyError';
      for (const op of [item.get, item.post].filter(Boolean)) {
        for (const [code, res] of Object.entries(op.responses as Record<string, any>)) {
          const ref = res.content?.['application/json']?.schema?.$ref;
          if (Number(code) < 400 || ref === undefined) continue;
          expect(ref, `${path} → ${code}`).toBe(expected);
        }
      }
    }
  });

  describe('sparse fieldsets vs required (#367)', () => {
    /** The item/location field vocabularies a caller may name in `fields` / `$select`. */
    const itemFields = [...ITEM_FIELD_REGISTRY.keys()];
    const locationFields = [...LOCATION_FIELD_REGISTRY.keys()];

    it('lists exactly the selectable names in the `fields` parameter’s own prose', () => {
      // The parameter description names the vocabulary a caller may pass; a name missing from it
      // is a valid request the document calls a 400, and a name it invents is the reverse.
      const validFields = (path: string): string[] => {
        const param = (doc.paths[path].get.parameters as { name: string; description: string }[]).find(
          (p) => p.name === 'fields',
        )!;
        return param.description.split('Valid fields: ')[1]!.split('.')[0]!.split(', ');
      };
      expect(validFields('/api/v1/items')).toEqual(itemFields);
      expect(validFields('/api/v1/locations')).toEqual(locationFields);
    });

    it('describes exactly the projectable item fields, no more and no fewer', () => {
      // The drift guard: a field added to the engine but not described here (or vice versa)
      // fails the build rather than silently shipping an under-documented projection.
      expect(Object.keys(doc.components.schemas.ItemProjection.properties)).toEqual(itemFields);
      expect(Object.keys(doc.components.schemas.Location.properties)).toEqual(locationFields);
    });

    it('keeps the strict shapes exactly as the engine reports its default payloads', () => {
      expect(doc.components.schemas.ItemSummary.required).toEqual([...ITEM_SUMMARY_DEFAULT_FIELDS]);
      const detail = [
        ...doc.components.schemas.ItemSummary.required,
        ...Object.keys(doc.components.schemas.ItemDetail.allOf[1].properties),
      ];
      // `fieldValues` is the one described-but-not-default detail property (include=fields).
      expect(detail.filter((name) => name !== 'fieldValues')).toEqual([...ITEM_DETAIL_DEFAULT_FIELDS]);
    });

    it('answers every projectable read with a projection-tolerant schema', () => {
      // Each read that advertises `fields` must resolve its payload to a schema that admits a
      // partial object — otherwise a client generated from `required` throws the moment anyone
      // uses the headline sparse-fieldset feature.
      const deref = (schema: any): any =>
        schema.$ref === undefined
          ? schema
          : doc.components.schemas[schema.$ref.replace('#/components/schemas/', '')];
      const payloadRef = (path: string): string => {
        const body = doc.paths[path].get.responses['200'].content['application/json'].schema;
        // The rows inside a list/search envelope, or the single resource itself.
        const schema = deref(body);
        const rows = schema.properties?.data?.items ?? schema.properties?.matches?.items ?? body;
        // A `$ref`, or (on search, whose two shapes genuinely differ) one branch of an `anyOf`.
        return (rows.anyOf ?? [rows]).map((s: { $ref: string }) => s.$ref).join(' | ');
      };
      expect(payloadRef('/api/v1/items')).toBe('#/components/schemas/ItemProjection');
      expect(payloadRef('/api/v1/items/{id}')).toBe('#/components/schemas/ItemProjection');
      expect(payloadRef('/api/v1/search')).toContain('#/components/schemas/ItemProjection');
      expect(payloadRef('/api/v1/locations')).toBe('#/components/schemas/Location');
      expect(payloadRef('/api/v1/locations/{id}')).toBe('#/components/schemas/Location');

      // …and each of those schemas — nested elements included — really is required-free.
      for (const name of [
        'ItemProjection',
        'Location',
        'PlacementProjection',
        'CapabilityProjection',
        'ItemFieldValueProjection',
        'LocationFieldValue',
      ]) {
        expect(doc.components.schemas[name].required, `${name} must not declare required`).toBeUndefined();
      }
    });

    it('keeps a strict twin wherever a response genuinely cannot be projected', () => {
      // The guarantee is not simply dropped: the shapes behind the SSE stream and the write
      // endpoints are still published in full, because nothing can project those.
      expect(doc.components.schemas.ItemSummary.required.length).toBeGreaterThan(0);
      expect(doc.components.schemas.ItemDetail.allOf[1].required).toEqual(['placements', 'capabilities']);
      for (const name of ['Placement', 'Capability', 'ItemFieldValue', 'ItemMatch']) {
        expect(doc.components.schemas[name].required.length, name).toBeGreaterThan(0);
      }
    });
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
